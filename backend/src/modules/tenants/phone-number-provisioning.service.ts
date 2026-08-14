import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import {
  TenantPhoneNumber,
  PhoneNumberAllocationStatus,
  PhoneNumberProvider,
  CommunicationIntegration,
  Tenant,
  PhoneNumberOrder,
  PhoneNumberOrderType,
  PhoneNumberOrderStatus,
  PhoneNumberPricing,
  PricingType,
  Workspace,
  ApiKey,
  WebhookSubscription,
} from '../../database/entities';
import { CommunicationBusiness } from '../../database/entities/communication-business.entity';
import { CommunicationProfile } from '../../database/entities/communication-profile.entity';
import { ProfilePhoneAssignment } from '../../database/entities/profile-phone-assignment.entity';
import { IntegrationStatus, ProviderType } from '../../database/entities/communication-integration.entity';
import { ChannelType } from '../../database/entities/sender.entity';
import { EncryptionService } from '../../common/services/encryption.service';
import { TwilioProvider } from '../communication/providers/twilio.provider';
import { TwilioSubaccountProvisionerService } from '../integrations/twilio-subaccount-provisioner.service';
import { ensureOutboundReadyForTenantPhone } from './ensure-outbound-ready.helpers';
import type { PurchaseChannel } from './dto/phone-number-provisioning.dto';

export interface AvailableNumberWithPricing {
  phoneNumber: string;
  locality?: string;
  region?: string;
  country: string;
  capabilities: string[];
  // Pricing breakdown
  twilioCost: number;
  markupAmount: number;
  totalMonthlyPrice: number;
  setupFee: number;
}

export interface PurchaseResult {
  success: boolean;
  order: PhoneNumberOrder;
  allocation?: TenantPhoneNumber;
  error?: string;
}

export interface ReleaseResult {
  success: boolean;
  order: PhoneNumberOrder;
  error?: string;
}

export interface PricingConfig {
  pricingType: PricingType;
  monthlyBasePrice?: number;
  monthlyMarkupAmount: number;
  monthlyMarkupPercentage: number;
  setupFee: number;
  allowTenantPurchase: boolean;
  allowTenantRelease: boolean;
  messagingServiceSid?: string;
}

@Injectable()
export class PhoneNumberProvisioningService {
  private readonly logger = new Logger(PhoneNumberProvisioningService.name);

  // Default Twilio monthly cost for US local numbers (approximate)
  private readonly DEFAULT_TWILIO_MONTHLY_COST = 1.15;

  constructor(
    @InjectRepository(PhoneNumberOrder)
    private orderRepo: Repository<PhoneNumberOrder>,
    @InjectRepository(PhoneNumberPricing)
    private pricingRepo: Repository<PhoneNumberPricing>,
    @InjectRepository(TenantPhoneNumber)
    private tenantPhoneRepo: Repository<TenantPhoneNumber>,
    @InjectRepository(CommunicationIntegration)
    private integrationRepo: Repository<CommunicationIntegration>,
    @InjectRepository(Tenant)
    private tenantRepo: Repository<Tenant>,
    @InjectRepository(Workspace)
    private workspaceRepo: Repository<Workspace>,
    @InjectRepository(CommunicationBusiness)
    private communicationBusinessRepo: Repository<CommunicationBusiness>,
    @InjectRepository(CommunicationProfile)
    private communicationProfileRepo: Repository<CommunicationProfile>,
    @InjectRepository(ProfilePhoneAssignment)
    private profilePhoneAssignmentRepo: Repository<ProfilePhoneAssignment>,
    @InjectRepository(WebhookSubscription)
    private webhookSubscriptionRepo: Repository<WebhookSubscription>,
    @InjectRepository(ApiKey)
    private apiKeyRepo: Repository<ApiKey>,
    private encryptionService: EncryptionService,
    private twilioProvider: TwilioProvider,
    private configService: ConfigService,
    // Task 6B.5A: lazy Twilio-subaccount provisioning on first purchase.
    // Injected here rather than at construction of TwilioProvider so the
    // preflight + state-machine logic is testable in isolation.
    private twilioSubaccountProvisioner: TwilioSubaccountProvisionerService,
  ) {}

  /**
   * Wave-3 completion 2026-07-18 — resolve the correct
   * `communication_integrations.id` to stamp on a freshly created
   * TenantPhoneNumber. Deterministic; mirrors `ProviderContextResolver`'s
   * rules 3 → 4 without throwing (returns null on ambiguity so callers
   * can log and continue rather than roll back a Twilio purchase).
   *
   * Priority:
   *   1. TENANT-scoped row for (workspaceId, provider, ownerTenantId=tenantId)
   *   2. WORKSPACE-scoped row for (workspaceId, provider, ownerTenantId IS NULL)
   *   3. Legacy — exactly one active row for (workspaceId, provider)
   *      regardless of scope. This matches the resolver's compatibility
   *      mode and covers pre-Wave-2 workspaces.
   *
   * Returns null (with a warning log) when zero or >1 candidates are
   * ambiguous. The TPN is left unstamped in that case and the
   * `audit-provider-context` report surfaces it for manual repair.
   */
  private async resolveIntegrationIdForTpnStamp(
    workspaceId: string,
    tenantId: string,
    provider: ProviderType,
  ): Promise<string | null> {
    // Rule 3 — TENANT-scoped
    const tenantScoped = await this.integrationRepo.findOne({
      where: {
        workspaceId,
        provider,
        scopeType: 'TENANT',
        ownerTenantId: tenantId,
        status: IntegrationStatus.ACTIVE,
      },
    });
    if (tenantScoped) return tenantScoped.id;

    // Rule 4 — WORKSPACE-scoped
    const workspaceScoped = await this.integrationRepo.findOne({
      where: {
        workspaceId,
        provider,
        ownerTenantId: IsNull(),
        status: IntegrationStatus.ACTIVE,
      },
    });
    if (workspaceScoped) return workspaceScoped.id;

    // Legacy — any single active row
    const legacy = await this.integrationRepo.find({
      where: { workspaceId, provider, status: IntegrationStatus.ACTIVE },
    });
    if (legacy.length === 1) return legacy[0].id;

    this.logger.warn(
      `[stampTpn] ambiguous or missing integration for workspace=${workspaceId} tenant=${tenantId} provider=${provider} (candidates=${legacy.length}); TPN left unstamped`,
    );
    return null;
  }

  /**
   * Materialize the (CommunicationBusiness → default CommunicationProfile →
   * ProfilePhoneAssignment) chain a freshly purchased TenantPhoneNumber needs
   * before outbound resolution will accept it. Idempotent.
   *
   * Failure here MUST NOT roll back the Twilio purchase — the number is
   * already provisioned upstream and the order has been billed. We log a
   * clear warning so the next call (or a manual re-trigger) can heal the
   * chain, and the operator can fall back to admin/phone-numbers/assign.
   */
  private async ensureOutboundReady(allocation: TenantPhoneNumber): Promise<void> {
    try {
      const tenant = await this.tenantRepo.findOne({
        where: { id: allocation.tenantId, workspaceId: allocation.workspaceId },
      });
      if (!tenant) {
        this.logger.warn(
          `[ensureOutboundReady] tenant ${allocation.tenantId} not found — skipping (phone ${allocation.phoneNumber} purchased but not linked)`,
        );
        return;
      }

      const webhooks = await this.webhookSubscriptionRepo.find({
        where: { tenantId: allocation.tenantId },
        select: ['webhookUrl'],
      });
      const apiKeys = await this.apiKeyRepo.find({
        where: { tenantId: allocation.tenantId },
        select: ['name'],
      });

      const result = await ensureOutboundReadyForTenantPhone(
        {
          business: this.communicationBusinessRepo,
          profile: this.communicationProfileRepo,
          ppa: this.profilePhoneAssignmentRepo,
        },
        allocation,
        {
          name: tenant.name ?? null,
          externalId: tenant.externalId ?? null,
          webhookUrls: webhooks.map((w) => w.webhookUrl).filter((u): u is string => !!u),
          apiKeyNames: apiKeys.map((k) => k.name).filter((n): n is string => !!n),
        },
      );

      if (result.changed) {
        this.logger.log(
          `[ensureOutboundReady] ${allocation.phoneNumber} → business=${result.businessId.slice(0, 8)} profile=${result.profileId.slice(0, 8)} ppa=${result.ppaId.slice(0, 8)}`,
        );
      }
    } catch (err: any) {
      // Twilio purchase already succeeded; record so operator can heal via
      // POST /admin/phone-numbers/assign. Do NOT throw.
      this.logger.warn(
        `[ensureOutboundReady] Failed to materialize outbound chain for ${allocation.phoneNumber} (tenant=${allocation.tenantId}): ${err?.message ?? err}. Re-running the helper or calling /admin/phone-numbers/assign will heal it.`,
      );
    }
  }

  /**
   * Search available phone numbers with pricing information
   */
  async searchAvailableNumbers(
    workspaceId: string,
    country: string,
    areaCode?: string,
    options?: { smsCapable?: boolean; voiceCapable?: boolean; locality?: string; region?: string },
  ): Promise<AvailableNumberWithPricing[]> {
    this.logger.log(`Searching available numbers: workspace=${workspaceId}, country=${country}, areaCode=${areaCode}, locality=${options?.locality}, region=${options?.region}`);

    // Get Twilio integration
    const integration = await this.integrationRepo.findOne({
      where: { workspaceId, provider: ProviderType.TWILIO, status: IntegrationStatus.ACTIVE },
    });

    if (!integration) {
      throw new BadRequestException('No active Twilio integration found. Please connect Twilio first.');
    }

    const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);

    // Search Twilio for available numbers
    const availableNumbers = await this.twilioProvider.searchAvailableNumbers(
      credentials,
      country,
      areaCode,
      { locality: options?.locality, region: options?.region },
    );

    // Get pricing config
    const pricingConfig = await this.getPricingConfig(workspaceId);

    // Map to response with pricing
    return availableNumbers.map((num) => {
      const pricing = this.calculatePrice(pricingConfig, country);
      return {
        phoneNumber: num.phoneNumber,
        locality: num.locality,
        region: num.region,
        country,
        capabilities: num.capabilities || [],
        twilioCost: pricing.twilioCost,
        markupAmount: pricing.markupAmount,
        totalMonthlyPrice: pricing.totalPrice,
        setupFee: pricing.setupFee,
      };
    });
  }

  /**
   * Purchase a phone number for a tenant
   */
  async purchaseNumber(
    workspaceId: string,
    tenantId: string,
    phoneNumber: string,
    orderedBy?: string,
    friendlyName?: string,
    // Wave-2 Voice Foundation PR 4: purchase channel selector. Optional; when
    // omitted defaults to 'sms' so all pre-PR-4 callers see byte-identical
    // behaviour. See PurchasePhoneNumberDto for the semantics of each value.
    channel: 'sms' | 'voice' | 'both' = 'sms',
  ): Promise<PurchaseResult> {
    this.logger.log(`Purchasing number: workspace=${workspaceId}, tenant=${tenantId}, number=${phoneNumber}`);

    // Verify tenant exists
    const tenant = await this.tenantRepo.findOne({
      where: { id: tenantId, workspaceId },
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    // Get Twilio integration
    const integration = await this.integrationRepo.findOne({
      where: { workspaceId, provider: ProviderType.TWILIO, status: IntegrationStatus.ACTIVE },
    });

    if (!integration) {
      throw new BadRequestException('No active Twilio integration found');
    }

    // Get pricing
    const pricingConfig = await this.getPricingConfig(workspaceId);
    const pricing = this.calculatePrice(pricingConfig, 'US'); // TODO: Detect country from number

    // Create order record
    const order = this.orderRepo.create({
      workspaceId,
      tenantId,
      phoneNumber,
      orderType: PhoneNumberOrderType.PURCHASE,
      status: PhoneNumberOrderStatus.PENDING,
      twilioCost: pricing.twilioCost,
      markupAmount: pricing.markupAmount,
      totalPrice: pricing.totalPrice,
      orderedBy,
      metadata: {},
    });
    await this.orderRepo.save(order);

    try {
      // Update status to provisioning
      order.status = PhoneNumberOrderStatus.PROVISIONING;
      await this.orderRepo.save(order);

      // Wave-2 Task 6B.5A — lazy Twilio subaccount provisioning.
      //
      // For workspaces provisioned via the Task 6B.2 identity API, the
      // integration row starts with `operational_status = 'pending_credentials'`
      // and empty encrypted credentials. Before we can make any Twilio API
      // call on behalf of this workspace, we need Sigcore to mint a
      // subaccount under its master account, encrypt the subaccount's
      // credentials onto this row, and confirm preflight succeeds.
      //
      // The provisioner is idempotent (short-circuits on `ready`) and
      // safe under concurrency (holds a SELECT … FOR UPDATE lock on the
      // integration row). Repeated calls will reuse the existing
      // subaccount rather than mint duplicates.
      //
      // Grandfathered rows (pilot workspace: NULL operational_status +
      // populated credentials) short-circuit inside ensureReady.
      const readyIntegration = await this.twilioSubaccountProvisioner.ensureReady(
        integration.id,
      );

      // Purchase from Twilio using the (now guaranteed operational) row's credentials.
      const credentials = this.encryptionService.decrypt(readyIntegration.credentialsEncrypted);
      const purchased = await this.twilioProvider.purchasePhoneNumber(credentials, phoneNumber);

      order.phoneNumberSid = purchased.sid;
      order.metadata = {
        ...order.metadata,
        capabilities: purchased.capabilities,
        friendlyName: purchased.friendlyName,
        requestedChannel: channel,
      };

      // Wave-2 Voice Foundation PR 4: verify Twilio-reported capabilities
      // support the requested channel BEFORE we commit further state. If the
      // caller asked for voice on an SMS-only number, or SMS on a voice-only
      // number, fail loud rather than allocate silently-broken routing.
      this.assertPurchaseChannelMatchesCapabilities(
        channel,
        purchased.capabilities ?? [],
        phoneNumber,
      );

      // Configure webhooks on the new number — channel-scoped. Twilio's REST
      // update preserves unlisted fields (per `updateNumberWebhooks`'s
      // contract from PR 1), so voice-only purchases never touch SMS state
      // and vice versa.
      const baseUrl = this.configService.get('BASE_URL') || process.env.BASE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);
      if (baseUrl) {
        // Use workspaceId as the webhookId for Twilio webhooks
        const smsWebhookUrl = `${baseUrl}/api/webhooks/twilio/sms/${workspaceId}`;
        const voiceWebhookUrl = `${baseUrl}/api/webhooks/twilio/voice/${workspaceId}`;
        const voiceStatusCallbackUrl = `${baseUrl}/api/webhooks/twilio/voice/status`;

        const urls: {
          smsUrl?: string;
          voiceUrl?: string;
          statusCallbackUrl?: string;
        } = {};
        if (channel === 'sms' || channel === 'both') {
          urls.smsUrl = smsWebhookUrl;
        }
        if (channel === 'voice' || channel === 'both') {
          urls.voiceUrl = voiceWebhookUrl;
          urls.statusCallbackUrl = voiceStatusCallbackUrl;
        }
        await this.twilioProvider.updateNumberWebhooks(
          credentials,
          purchased.sid,
          urls,
        );
      }

      // Attach to Messaging Service for A2P 10DLC compliance
      let a2pStatus: string | undefined = undefined;
      let a2pMessagingServiceSid: string | undefined;
      let a2pAttachedAt: Date | undefined;

      // Wave-2 PR 4 — A2P attachment only when the allocation is SMS-capable
      // by request. Voice-only allocations skip this entirely so we don't
      // accidentally consume A2P registrations on numbers that will never
      // send SMS.
      const requestIncludesSms = channel === 'sms' || channel === 'both';
      if (requestIncludesSms && purchased.capabilities?.includes('sms')) {
        const a2pResult = await this.attachToMessagingService(
          credentials,
          purchased.sid,
          workspaceId,
        );

        if (a2pResult.success) {
          a2pStatus = 'ready';
          a2pMessagingServiceSid = a2pResult.messagingServiceSid;
          a2pAttachedAt = new Date();
          this.logger.log(`A2P attachment successful for ${phoneNumber}`);
        } else if (a2pResult.error === 'no_messaging_service_configured') {
          a2pStatus = undefined;
        } else {
          a2pStatus = 'failed';
          a2pMessagingServiceSid = a2pResult.messagingServiceSid;
          this.logger.warn(`A2P attachment failed for ${phoneNumber}: ${a2pResult.error}`);
        }
      }

      order.metadata = {
        ...order.metadata,
        a2pStatus,
        a2pMessagingServiceSid,
      };

      // Allocate to tenant.
      //
      // Wave-2 Voice Foundation PR 4 — TPN.channel mapping:
      //   requested 'sms'   → ChannelType.SMS
      //   requested 'voice' → ChannelType.VOICE
      //   requested 'both'  → ChannelType.SMS (single enum slot; the
      //                       full request intent lives in
      //                       metadata.activeChannels, which existing
      //                       outbound resolution can ignore safely and
      //                       future consumers can consult)
      const persistedChannel =
        channel === 'voice' ? ChannelType.VOICE : ChannelType.SMS;
      const activeChannels =
        channel === 'both' ? ['sms', 'voice'] : [channel];
      const allocation = this.tenantPhoneRepo.create({
        workspaceId,
        tenantId,
        phoneNumber: purchased.phoneNumber,
        friendlyName: friendlyName || purchased.friendlyName,
        provider: PhoneNumberProvider.TWILIO,
        providerId: purchased.sid,
        channel: persistedChannel,
        status: PhoneNumberAllocationStatus.ACTIVE,
        isDefault: false,
        provisionedViaCallio: true,
        orderId: order.id,
        monthlyCost: pricing.totalPrice,
        provisionedAt: new Date(),
        messagingServiceSid: a2pMessagingServiceSid,
        a2pStatus,
        a2pAttachedAt,
        metadata: {
          capabilities: purchased.capabilities,
          requestedChannel: channel,
          activeChannels,
        },
      });
      await this.tenantPhoneRepo.save(allocation);

      // Wave-3 completion 2026-07-18 — stamp TPN.communication_integration_id
      // so ProviderContextResolver rule 1 (by_number) resolves this TPN
      // deterministically. Missing this stamp is the exact bug that broke
      // Natallia + K&D on 2026-07-16 (409 ambiguous).
      const intId = await this.resolveIntegrationIdForTpnStamp(
        workspaceId, tenantId, PhoneNumberProvider.TWILIO as unknown as ProviderType,
      );
      if (intId) {
        allocation.communicationIntegrationId = intId;
        await this.tenantPhoneRepo.save(allocation);
        // Also stamp the order for symmetry — any downstream analysis
        // (billing, audit) can trace the purchase back to the integration.
        order.communicationIntegrationId = intId;
      }

      // Materialize CommunicationBusiness → default CommunicationProfile →
      // ProfilePhoneAssignment so outbound resolution accepts the new
      // number immediately. Sigcore owns this invariant; clients must not
      // construct the chain. Failures here are logged and do NOT roll
      // back the Twilio purchase — see ensureOutboundReady for recovery.
      await this.ensureOutboundReady(allocation);

      // Update order with allocation reference
      order.tenantPhoneNumberId = allocation.id;
      order.status = PhoneNumberOrderStatus.ACTIVE;
      order.completedAt = new Date();
      await this.orderRepo.save(order);

      this.logger.log(`Successfully purchased ${phoneNumber} for tenant ${tenantId}`);

      return {
        success: true,
        order,
        allocation,
      };
    } catch (error) {
      // Update order with failure
      order.status = PhoneNumberOrderStatus.FAILED;
      order.metadata = {
        ...order.metadata,
        errorMessage: error.message,
      };
      await this.orderRepo.save(order);

      this.logger.error(`Failed to purchase ${phoneNumber}: ${error.message}`);

      // Wave-2 PR 4: client-input validation errors (BadRequest) propagate
      // instead of getting swallowed as a soft-fail — the caller supplied a
      // channel that mismatches Twilio-reported capabilities and needs a
      // 400, not `{success: false}`. Every other error keeps its historical
      // soft-fail return so downstream orchestration (recovery, retries)
      // doesn't have to shift.
      if (error instanceof BadRequestException) {
        throw error;
      }

      return {
        success: false,
        order,
        error: error.message,
      };
    }
  }

  /**
   * Wave-2 Voice Foundation PR 4 — assert Twilio-reported capabilities
   * cover the requested purchase channel. Throws BadRequestException if
   * SMS was requested but the number is voice-only, or voice was
   * requested but the number is SMS-only. `both` requires both.
   *
   * The purpose is to fail loudly at purchase time so callers don't end
   * up with an allocation that can't route the traffic they asked for.
   */
  private assertPurchaseChannelMatchesCapabilities(
    channel: 'sms' | 'voice' | 'both',
    capabilities: string[],
    phoneNumber: string,
  ): void {
    const caps = new Set(capabilities.map((c) => c.toLowerCase()));
    const wantsSms = channel === 'sms' || channel === 'both';
    const wantsVoice = channel === 'voice' || channel === 'both';
    if (wantsSms && !caps.has('sms')) {
      throw new BadRequestException(
        `Number ${phoneNumber} is not SMS-capable but channel=${channel} was requested (Twilio capabilities: ${[...caps].join(',') || 'none'})`,
      );
    }
    if (wantsVoice && !caps.has('voice')) {
      throw new BadRequestException(
        `Number ${phoneNumber} is not voice-capable but channel=${channel} was requested (Twilio capabilities: ${[...caps].join(',') || 'none'})`,
      );
    }
  }

  /**
   * Wave-2 Task 4 (PR-1 correction, 2026-07-12) — apply a partial webhook
   * override to a purchased Twilio number. Used after `purchaseNumber` when
   * the caller supplied custom voice/fallback/status URLs that must override
   * the default workspace-scoped webhook URLs configured at purchase time.
   *
   * Only fields present in `urls` are sent to Twilio; every other webhook
   * attribute is preserved per Twilio's REST update semantics. Wraps
   * `TwilioProvider.updateNumberWebhooks`.
   *
   * Returns the provider result. Never throws — caller decides how to react
   * to a partial failure (e.g. the forVoice metadata still gets persisted so
   * operators can see the intent).
   */
  async applyPhoneNumberWebhookOverrides(
    workspaceId: string,
    phoneNumberSid: string,
    urls: {
      smsUrl?: string;
      voiceUrl?: string;
      voiceFallbackUrl?: string;
      statusCallbackUrl?: string;
    },
  ): Promise<{ success: boolean; applied: string[]; error?: string }> {
    if (
      urls.smsUrl === undefined &&
      urls.voiceUrl === undefined &&
      urls.voiceFallbackUrl === undefined &&
      urls.statusCallbackUrl === undefined
    ) {
      return { success: true, applied: [] };
    }
    const integration = await this.integrationRepo.findOne({
      where: {
        workspaceId,
        provider: ProviderType.TWILIO,
        status: IntegrationStatus.ACTIVE,
      },
    });
    if (!integration) {
      return {
        success: false,
        applied: [],
        error: `No active Twilio integration in workspace ${workspaceId}`,
      };
    }
    const credentials = this.encryptionService.decrypt(
      integration.credentialsEncrypted,
    );
    return this.twilioProvider.updateNumberWebhooks(
      credentials,
      phoneNumberSid,
      urls,
    );
  }

  /**
   * Update an existing allocation's channel configuration in-place.
   *
   * Fixes the class of bug documented in docs/AUDIT_TPN_ACTIVECHANNELS_STUCK.md
   * (Globus Service 2026-08 incident): metadata.activeChannels was frozen at
   * purchase-time with no post-purchase update path, and the only "fix" was
   * DELETE + repurchase — which swaps the phone number, breaking existing
   * customer SMS history and any external references. This endpoint fixes
   * the row in place without touching the phone number identity.
   *
   * Behavior:
   *   1. Loads TPN by (id, workspaceId, tenantId). 404 when not found.
   *   2. Idempotency: no-op if the requested channel matches the current
   *      metadata.requestedChannel — returns unchanged allocation.
   *   3. Capability validation: rejects if trying to add a channel the
   *      underlying Twilio number doesn't support (per `metadata.capabilities`
   *      captured at purchase time). Prevents enabling voice on an SMS-only
   *      Twilio number.
   *   4. Configures Twilio webhooks for the target channel set (partial
   *      update via TwilioProvider.updateNumberWebhooks — safe to run
   *      idempotently). Adds URLs for channels being enabled; leaves
   *      existing URLs in place for channels being removed (the operator
   *      can explicitly `release` if they want to decommission fully).
   *   5. Updates DB row: metadata.activeChannels, metadata.requestedChannel,
   *      and the `channel` enum column (mirrors purchase-time mapping — see
   *      persistedChannel logic in purchaseNumber).
   *   6. When adding SMS, re-runs ensureOutboundReady (idempotent) so the
   *      CommunicationBusiness → Profile → PPA chain is materialized.
   *
   * Never touches Twilio phone-number identity; the underlying provider SID
   * and the E.164 number are unchanged.
   */
  async updateAllocationChannel(
    workspaceId: string,
    tenantId: string,
    allocationId: string,
    requestedChannel: PurchaseChannel,
    opts?: { preserveWebhooks?: boolean; reconcile?: boolean },
  ): Promise<TenantPhoneNumber> {
    const preserveWebhooks = opts?.preserveWebhooks === true;
    const reconcile = opts?.reconcile === true;
    if (preserveWebhooks && reconcile) {
      throw new BadRequestException(
        'preserveWebhooks and reconcile are mutually exclusive — the whole point of reconcile is to write webhooks.',
      );
    }
    const allocation = await this.tenantPhoneRepo.findOne({
      where: { id: allocationId, workspaceId, tenantId },
    });
    if (!allocation) {
      throw new NotFoundException('Phone number allocation not found');
    }

    const metadata = (allocation.metadata ?? {}) as Record<string, unknown>;
    const currentRequestedChannel = metadata.requestedChannel as PurchaseChannel | undefined;

    // Idempotency — matches purchase-time metadata shape exactly.
    // Reconcile mode bypasses this so carrier drift (metadata says one thing,
    // Twilio says another) can be repaired. In reconcile mode, the Twilio-write
    // stage below itself diffs current vs. desired and writes zero URLs when
    // Twilio is already correct — so reconcile against an already-correct
    // number remains a no-op end-to-end.
    if (!reconcile && currentRequestedChannel === requestedChannel) {
      this.logger.log(
        `[updateAllocationChannel] no-op — allocation=${allocationId} phone=${allocation.phoneNumber} already at channel=${requestedChannel}`,
      );
      return allocation;
    }

    const nextActiveChannels: Array<'sms' | 'voice'> =
      requestedChannel === 'both' ? ['sms', 'voice'] : [requestedChannel];

    // Load Twilio integration — needed for both webhook rewrite AND the
    // optional live-capability fetch used when this legacy row is missing
    // metadata.capabilities.
    const integration = await this.integrationRepo.findOne({
      where: { workspaceId, provider: ProviderType.TWILIO, status: IntegrationStatus.ACTIVE },
    });
    if (!integration?.credentialsEncrypted) {
      throw new BadRequestException(
        `No active Twilio integration in workspace ${workspaceId} — cannot reconfigure webhooks`,
      );
    }
    const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);

    // Capability source of truth:
    //   1) metadata.capabilities if present (fast path — set at purchase time by Wave-2 PR 4)
    //   2) Twilio live fetch (when metadata.capabilities is absent AND we have a providerId).
    //      Used for legacy BYO rows (created before Wave-2) whose metadata is null.
    //   3) default-permissive fallback (extractCapabilities default) — matches the
    //      existing behavior for legacy rows that also lack a providerId.
    let capabilities = this.extractCapabilities(metadata);
    let capabilitiesArrayForWrite: string[] | undefined =
      (metadata as { capabilities?: unknown }).capabilities as string[] | undefined;
    const capsAlreadyInMetadata =
      Array.isArray((metadata as { capabilities?: unknown }).capabilities) &&
      ((metadata as { capabilities?: unknown[] }).capabilities as unknown[]).length > 0;
    if (!capsAlreadyInMetadata && allocation.providerId) {
      const pn = await this.twilioProvider.fetchPhoneNumberBySid(
        credentials,
        allocation.providerId,
      );
      if (pn) {
        // Trust Twilio phone-number identity — refuse if the SID resolves to a
        // different E.164 than the row we're editing (defense against stale SID).
        if (pn.phoneNumber !== allocation.phoneNumber) {
          throw new BadRequestException(
            `Twilio SID ${allocation.providerId} resolves to ${pn.phoneNumber}, ` +
            `not ${allocation.phoneNumber}. Refusing to normalize on mismatched identity.`,
          );
        }
        const twilioCaps = new Set<'sms' | 'voice'>();
        if (pn.capabilities.sms) twilioCaps.add('sms');
        if (pn.capabilities.voice) twilioCaps.add('voice');
        capabilities = twilioCaps;
        capabilitiesArrayForWrite = [...twilioCaps];
        this.logger.log(
          `[updateAllocationChannel] backfilled capabilities from Twilio allocation=${allocationId} ` +
          `phone=${allocation.phoneNumber} sid=${allocation.providerId} caps=${JSON.stringify(capabilitiesArrayForWrite)}`,
        );
      } else if (preserveWebhooks) {
        // In metadata-normalize mode, refusing to write "voice=true" without
        // authoritative carrier verification is the whole point. Refuse.
        throw new BadRequestException(
          `Twilio SID lookup failed for ${allocation.phoneNumber}. Refusing to normalize ` +
          `metadata without authoritative capability verification.`,
        );
      }
      // If preserveWebhooks=false AND Twilio fetch failed, fall through to
      // the default-permissive extractCapabilities behavior (existing
      // backward-compat behavior for non-preserve callers).
    }

    // Capability validation. Refuses channels the number physically can't support.
    for (const ch of nextActiveChannels) {
      if (!capabilities.has(ch)) {
        throw new BadRequestException(
          `Cannot enable channel '${ch}' — underlying Twilio number ${allocation.phoneNumber} ` +
          `does not support it (capabilities=${JSON.stringify([...capabilities])}). ` +
          `Only channels the physical number supports can be activated.`,
        );
      }
    }

    // Compute + apply Twilio webhook URLs for channels being enabled. Mirrors
    // the purchase-time URL derivation exactly. We do NOT clear webhooks for
    // channels being removed — leaving them in place is harmless (Sigcore's
    // guards will reject those channels going forward), and clearing them
    // risks losing inbound-signal capture on a channel the operator only
    // wanted to gate outbound-side.
    //
    // SKIPPED ENTIRELY when preserveWebhooks=true — metadata-only path.
    // Purpose (2026-08-14 legacy-TPN normalize): backfill Sigcore metadata
    // for BYO rows whose Twilio-side webhooks may point at intentional
    // routes (e.g. a demo/inbound-agent URL) that we do NOT want to
    // overwrite in this narrow-scope operation. Inbound routing is a
    // separate concern owned by the inbound-agent rollout.
    const baseUrl =
      this.configService.get('BASE_URL') ||
      process.env.BASE_URL ||
      (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);
    const currentActiveChannels = this.readActiveChannels(metadata);
    const addingSms = nextActiveChannels.includes('sms') && !currentActiveChannels.has('sms');
    const addingVoice = nextActiveChannels.includes('voice') && !currentActiveChannels.has('voice');

    // Compute the write payload for Twilio. Two modes:
    //
    //   preserveWebhooks=true  — never write Twilio (metadata-only path).
    //   reconcile=true         — write only URLs whose Twilio-side actual value
    //                            differs from desired. Idempotent against an
    //                            already-correct number.
    //   default                — pre-existing "adding-channels" gate: write
    //                            only URLs for channels being newly added.
    let urls: { smsUrl?: string; voiceUrl?: string; statusCallbackUrl?: string } = {};
    let twilioWriteReason = '';

    if (preserveWebhooks && (addingSms || addingVoice)) {
      this.logger.log(
        `[updateAllocationChannel] preserveWebhooks=true — skipping Twilio webhook update ` +
        `for allocation=${allocationId} phone=${allocation.phoneNumber} ` +
        `(would have set ${addingSms ? 'smsUrl ' : ''}${addingVoice ? 'voiceUrl statusCallbackUrl' : ''})`,
      );
    } else if (reconcile && baseUrl) {
      if (!allocation.providerId) {
        throw new BadRequestException(
          `Allocation ${allocationId} has no Twilio provider SID — cannot reconcile without live carrier state.`,
        );
      }
      // Fetch current Twilio state for the diff. Reject if the SID resolves
      // to a different number (defence against stale SID).
      const currentTwilio = await this.twilioProvider.fetchPhoneNumberBySid(
        credentials,
        allocation.providerId,
      );
      if (!currentTwilio) {
        throw new BadRequestException(
          `Twilio SID lookup failed for ${allocation.phoneNumber}. Refusing to reconcile without authoritative live state.`,
        );
      }
      if (currentTwilio.phoneNumber !== allocation.phoneNumber) {
        throw new BadRequestException(
          `Twilio SID ${allocation.providerId} resolves to ${currentTwilio.phoneNumber}, ` +
          `not ${allocation.phoneNumber}. Refusing to reconcile on mismatched identity.`,
        );
      }
      const desiredSmsUrl = nextActiveChannels.includes('sms')
        ? `${baseUrl}/api/webhooks/twilio/sms/${workspaceId}`
        : undefined;
      const desiredVoiceUrl = nextActiveChannels.includes('voice')
        ? `${baseUrl}/api/webhooks/twilio/voice/${workspaceId}`
        : undefined;
      const desiredStatusCallback = nextActiveChannels.includes('voice')
        ? `${baseUrl}/api/webhooks/twilio/voice/status`
        : undefined;

      if (desiredSmsUrl && currentTwilio.smsUrl !== desiredSmsUrl) {
        urls.smsUrl = desiredSmsUrl;
      }
      if (desiredVoiceUrl && currentTwilio.voiceUrl !== desiredVoiceUrl) {
        urls.voiceUrl = desiredVoiceUrl;
      }
      if (desiredStatusCallback && currentTwilio.statusCallback !== desiredStatusCallback) {
        urls.statusCallbackUrl = desiredStatusCallback;
      }
      twilioWriteReason = `reconcile diff — desired=${JSON.stringify({
        sms: desiredSmsUrl,
        voice: desiredVoiceUrl,
        statusCb: desiredStatusCallback,
      })} actual=${JSON.stringify({
        sms: currentTwilio.smsUrl,
        voice: currentTwilio.voiceUrl,
        statusCb: currentTwilio.statusCallback,
      })}`;
    } else if (baseUrl && (addingSms || addingVoice)) {
      if (addingSms) {
        urls.smsUrl = `${baseUrl}/api/webhooks/twilio/sms/${workspaceId}`;
      }
      if (addingVoice) {
        urls.voiceUrl = `${baseUrl}/api/webhooks/twilio/voice/${workspaceId}`;
        urls.statusCallbackUrl = `${baseUrl}/api/webhooks/twilio/voice/status`;
      }
      twilioWriteReason = `adding sms=${addingSms} voice=${addingVoice}`;
    }

    const urlKeys = Object.keys(urls);
    if (urlKeys.length > 0) {
      if (!allocation.providerId) {
        throw new BadRequestException(
          `Allocation ${allocationId} has no Twilio provider SID — cannot reconfigure webhooks. ` +
          `This row predates SID capture; release + repurchase to modernize it.`,
        );
      }
      const twilioResult = await this.twilioProvider.updateNumberWebhooks(
        credentials,
        allocation.providerId,
        urls,
      );
      if (!twilioResult.success) {
        // Do NOT persist metadata when the Twilio-side config failed. If we
        // stored activeChannels=['sms','voice'] without a voice URL on Twilio,
        // Sigcore's voice guards would pass but Twilio would fail the actual
        // call — reintroducing the silent-failure class this whole effort
        // is trying to eliminate.
        throw new BadRequestException(
          `Twilio webhook update failed for ${allocation.phoneNumber}: ${twilioResult.error ?? 'unknown error'}`,
        );
      }
      this.logger.log(
        `[updateAllocationChannel] Twilio URLs updated allocation=${allocationId} phone=${allocation.phoneNumber} applied=${twilioResult.applied.join(',')} reason=${twilioWriteReason}`,
      );
    } else if (reconcile) {
      this.logger.log(
        `[updateAllocationChannel] reconcile: no Twilio writes — carrier state already matches desired ` +
        `for allocation=${allocationId} phone=${allocation.phoneNumber}`,
      );
    }

    // Persist metadata + column. `channel` enum mirrors purchase-time
    // convention: 'both' → SMS enum with the true intent in metadata;
    // 'voice' → VOICE; 'sms' → SMS. See purchaseNumber:457-458 for the
    // original mapping.
    //
    // In reconcile mode, skip the DB write when metadata + column are
    // already at the target shape. Keeps reconcile against an already-
    // consistent row a true no-op.
    const nextColumnChannel =
      requestedChannel === 'voice' ? ChannelType.VOICE : ChannelType.SMS;
    const currentActiveSorted = [...currentActiveChannels].sort();
    const nextActiveSorted = [...nextActiveChannels].sort();
    const metadataUnchanged =
      reconcile &&
      currentRequestedChannel === requestedChannel &&
      allocation.channel === nextColumnChannel &&
      currentActiveSorted.length === nextActiveSorted.length &&
      currentActiveSorted.every((c, i) => c === nextActiveSorted[i]);
    if (!metadataUnchanged) {
      allocation.channel = nextColumnChannel;
      allocation.metadata = {
        ...metadata,
        requestedChannel,
        activeChannels: nextActiveChannels,
        ...(capabilitiesArrayForWrite ? { capabilities: capabilitiesArrayForWrite } : {}),
      };
      await this.tenantPhoneRepo.save(allocation);
      this.logger.log(
        `[updateAllocationChannel] allocation=${allocationId} phone=${allocation.phoneNumber} ` +
        `${currentRequestedChannel ?? 'legacy'} → ${requestedChannel} ` +
        `activeChannels=${JSON.stringify(nextActiveChannels)} ` +
        `preserveWebhooks=${preserveWebhooks} reconcile=${reconcile}`,
      );
    }

    // Re-materialize outbound chain when adding SMS. Idempotent — helper
    // returns changed=false when nothing new gets created. This is the
    // same call that runs at purchase time; skipping it on channel updates
    // would leave voice-added-later numbers unable to send SMS if the
    // CommunicationBusiness/Profile/PPA rows weren't set up at purchase.
    if (addingSms) {
      await this.ensureOutboundReady(allocation);
    }

    return allocation;
  }

  /**
   * Extract Twilio capabilities from TPN metadata. Falls back to the union of
   * (sms, voice) when capabilities is malformed or missing — pre-2026-08 rows
   * predate the capabilities-capture path but the numbers themselves generally
   * support both. Conservative: default-open on missing data means legitimate
   * upgrades work; the channel guard downstream is the real safety net.
   */
  private extractCapabilities(
    metadata: Record<string, unknown>,
  ): Set<'sms' | 'voice'> {
    const raw = (metadata as { capabilities?: unknown }).capabilities;
    if (Array.isArray(raw)) {
      const out = new Set<'sms' | 'voice'>();
      for (const v of raw) {
        if (v === 'sms' || v === 'voice') out.add(v);
      }
      if (out.size > 0) return out;
    }
    // Object shape from Twilio's Node client: { sms: true, voice: true, mms: true }.
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>;
      const out = new Set<'sms' | 'voice'>();
      if (obj.sms === true) out.add('sms');
      if (obj.voice === true) out.add('voice');
      if (out.size > 0) return out;
    }
    return new Set<'sms' | 'voice'>(['sms', 'voice']);
  }

  /**
   * Read the currently-active channel set from TPN metadata. Handles the
   * legacy shape where the row predates metadata.activeChannels by falling
   * back to the enum column.
   */
  private readActiveChannels(
    metadata: Record<string, unknown>,
  ): Set<'sms' | 'voice'> {
    const raw = (metadata as { activeChannels?: unknown }).activeChannels;
    if (Array.isArray(raw)) {
      const out = new Set<'sms' | 'voice'>();
      for (const v of raw) {
        if (v === 'sms' || v === 'voice') out.add(v);
      }
      return out;
    }
    return new Set<'sms' | 'voice'>();
  }

  /**
   * Release a phone number from a tenant
   */
  async releaseNumber(
    workspaceId: string,
    tenantId: string,
    allocationId: string,
    orderedBy?: string,
  ): Promise<ReleaseResult> {
    this.logger.log(`Releasing number: workspace=${workspaceId}, tenant=${tenantId}, allocation=${allocationId}`);

    // Get allocation
    const allocation = await this.tenantPhoneRepo.findOne({
      where: { id: allocationId, workspaceId, tenantId },
    });

    if (!allocation) {
      throw new NotFoundException('Phone number allocation not found');
    }

    // Get Twilio integration up front — needed for both the standard
    // release path AND the BYO-ghost detection below.
    const integration = await this.integrationRepo.findOne({
      where: { workspaceId, provider: ProviderType.TWILIO, status: IntegrationStatus.ACTIVE },
    });

    if (!integration) {
      throw new BadRequestException('No active Twilio integration found');
    }

    // BYO / imported number (provisionedViaCallio=false) — the original
    // guard forbade release outright because we don't own the number in
    // Twilio. But that leaves stale rows for numbers that were released
    // in Twilio outside of Sigcore (customer took their number back, a
    // subaccount migration, admin manual delete). Those become permanent
    // ghosts in inventory with no way to clean them up.
    //
    // Ghost-detection: ask Twilio if the number is actually there. If
    // Twilio doesn't hold it, it's a genuine ghost — safe to deallocate
    // locally without touching Twilio. If Twilio DOES hold it, it's a
    // live customer-owned number and we must not release it; keep the
    // guard.
    if (!allocation.provisionedViaCallio) {
      const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);
      const currentSid = await this.twilioProvider.findPhoneNumberSid(
        credentials,
        allocation.phoneNumber,
      );
      if (currentSid !== null) {
        throw new BadRequestException('Cannot release a number that was not provisioned through Callio');
      }

      // Ghost path — Twilio has no record, so nothing to release
      // externally. Deallocate the local row + record an audit order so
      // the cleanup is visible in tenant order history.
      this.logger.warn(
        `${allocation.phoneNumber} is a BYO ghost (provisionedViaCallio=false, Twilio has no matching number) — deallocating local row`,
      );
      const ghostOrder = this.orderRepo.create({
        workspaceId,
        tenantId,
        phoneNumber: allocation.phoneNumber,
        phoneNumberSid: allocation.providerId,
        orderType: PhoneNumberOrderType.RELEASE,
        status: PhoneNumberOrderStatus.RELEASED,
        tenantPhoneNumberId: undefined,
        orderedBy,
        completedAt: new Date(),
        metadata: {
          ghostByoDeallocation: true,
          storedSid: allocation.providerId ?? null,
          reason: 'provisionedViaCallio=false and phoneNumber not in Twilio account',
        },
      });
      await this.tenantPhoneRepo.remove(allocation);
      await this.orderRepo.save(ghostOrder);
      return { success: true, order: ghostOrder };
    }

    // Create release order
    const order = this.orderRepo.create({
      workspaceId,
      tenantId,
      phoneNumber: allocation.phoneNumber,
      phoneNumberSid: allocation.providerId,
      orderType: PhoneNumberOrderType.RELEASE,
      status: PhoneNumberOrderStatus.RELEASING,
      tenantPhoneNumberId: allocation.id,
      orderedBy,
      metadata: {},
    });
    await this.orderRepo.save(order);

    try {
      const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);

      // Remove from Messaging Service if attached
      if (allocation.messagingServiceSid && allocation.providerId) {
        await this.twilioProvider.removeNumberFromMessagingService(
          credentials,
          allocation.messagingServiceSid,
          allocation.providerId,
        ).catch((err) => {
          this.logger.warn(`Failed to remove from Messaging Service (non-blocking): ${err.message}`);
        });
      }

      // Release from Twilio. If Twilio 404s the stored SID (SIDs can rotate
      // on subaccount transfers, re-purchases, or manual Console moves —
      // real-world case observed 2026-07-20 with 4 leaked LB tenant phones
      // where Sigcore's stored PN...SIDs no longer existed in the account
      // but the numbers themselves were still there under fresh SIDs),
      // fall back to a phone-number lookup, update our stored SID, and
      // retry the release with the current one. If Twilio's account
      // genuinely doesn't hold the number anymore, treat that as an
      // already-released success — nothing to do at Twilio, just
      // deallocate the local record so the ghost row stops showing up in
      // inventory.
      let usedSid: string = allocation.providerId!;
      let sidResolvedViaLookup = false;
      try {
        await this.twilioProvider.releasePhoneNumber(credentials, usedSid);
      } catch (releaseErr: any) {
        const isNotFound =
          releaseErr?.status === 404 ||
          releaseErr?.code === 20404 ||
          /was not found/i.test(releaseErr?.message ?? '');
        if (!isNotFound) throw releaseErr;

        this.logger.warn(
          `Stored SID ${usedSid} not found in Twilio for ${allocation.phoneNumber}; re-resolving via findPhoneNumberSid`,
        );
        const currentSid = await this.twilioProvider.findPhoneNumberSid(
          credentials,
          allocation.phoneNumber,
        );
        if (currentSid && currentSid !== usedSid) {
          usedSid = currentSid;
          sidResolvedViaLookup = true;
          this.logger.log(
            `Re-resolved ${allocation.phoneNumber}: stored ${allocation.providerId} → current ${usedSid}; retrying release`,
          );
          await this.twilioProvider.releasePhoneNumber(credentials, usedSid);
        } else if (!currentSid) {
          this.logger.warn(
            `${allocation.phoneNumber} not in Twilio account at all — deallocating locally as an already-released number`,
          );
          // Fall through to the deallocate step below; the Twilio-side is
          // already clean, no retry needed.
        } else {
          // currentSid === usedSid but Twilio still 404s — the number
          // really is gone from this account under this exact SID. Treat
          // as already-released and deallocate locally.
          this.logger.warn(
            `${allocation.phoneNumber} SID ${usedSid} 404 with no alternative — treating as already-released`,
          );
        }
      }

      // Deallocate from tenant
      await this.tenantPhoneRepo.remove(allocation);

      // Update order — record the SID actually released against, so audit
      // trails can distinguish "released via stored SID" from "self-healed".
      order.status = PhoneNumberOrderStatus.RELEASED;
      order.completedAt = new Date();
      order.tenantPhoneNumberId = undefined; // Allocation no longer exists
      order.phoneNumberSid = usedSid;
      if (sidResolvedViaLookup) {
        order.metadata = {
          ...(order.metadata as Record<string, unknown> | undefined ?? {}),
          selfHealedFromSid: allocation.providerId ?? null,
          resolvedSid: usedSid,
        };
      }
      await this.orderRepo.save(order);

      this.logger.log(
        `Successfully released ${allocation.phoneNumber} from tenant ${tenantId}` +
          (sidResolvedViaLookup ? ` (self-healed SID ${allocation.providerId} → ${usedSid})` : ''),
      );

      return {
        success: true,
        order,
      };
    } catch (error) {
      // Update order with failure
      order.status = PhoneNumberOrderStatus.FAILED;
      order.metadata = {
        ...order.metadata,
        errorMessage: error.message,
      };
      await this.orderRepo.save(order);

      this.logger.error(`Failed to release ${allocation.phoneNumber}: ${error.message}`);

      return {
        success: false,
        order,
        error: error.message,
      };
    }
  }

  /**
   * Get order history for a tenant
   */
  async getTenantOrderHistory(
    workspaceId: string,
    tenantId: string,
  ): Promise<PhoneNumberOrder[]> {
    return this.orderRepo.find({
      where: { workspaceId, tenantId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Get all orders for a workspace, honoring the caller's scope.
   *
   * Workspace-scoped caller (callerTenantId=null): all orders in the workspace.
   * Tenant-scoped caller: only orders for their own tenant. This endpoint
   * previously leaked cross-tenant order history to any tenant key sitting in
   * the shared master workspace.
   */
  async getWorkspaceOrderHistory(
    workspaceId: string,
    callerTenantId?: string | null,
  ): Promise<PhoneNumberOrder[]> {
    if (callerTenantId) {
      return this.orderRepo.find({
        where: { workspaceId, tenantId: callerTenantId },
        order: { createdAt: 'DESC' },
        relations: ['tenant'],
      });
    }
    return this.orderRepo.find({
      where: { workspaceId },
      order: { createdAt: 'DESC' },
      relations: ['tenant'],
    });
  }

  /**
   * Get pricing configuration for a workspace
   */
  async getPricingConfig(workspaceId: string): Promise<PricingConfig> {
    const pricing = await this.pricingRepo.findOne({
      where: { workspaceId },
    });

    if (!pricing) {
      // Return default pricing
      return {
        pricingType: PricingType.FIXED_MARKUP,
        monthlyMarkupAmount: 0.50, // $0.50 default markup
        monthlyMarkupPercentage: 0,
        setupFee: 0,
        allowTenantPurchase: false,
        allowTenantRelease: false,
      };
    }

    return {
      pricingType: pricing.pricingType,
      monthlyBasePrice: pricing.monthlyBasePrice ? Number(pricing.monthlyBasePrice) : undefined,
      monthlyMarkupAmount: Number(pricing.monthlyMarkupAmount),
      monthlyMarkupPercentage: Number(pricing.monthlyMarkupPercentage),
      setupFee: Number(pricing.setupFee),
      allowTenantPurchase: pricing.allowTenantPurchase,
      allowTenantRelease: pricing.allowTenantRelease,
      messagingServiceSid: pricing.messagingServiceSid || undefined,
    };
  }

  /**
   * Update pricing configuration for a workspace
   */
  async updatePricingConfig(
    workspaceId: string,
    config: Partial<PricingConfig>,
  ): Promise<PhoneNumberPricing> {
    let pricing = await this.pricingRepo.findOne({
      where: { workspaceId },
    });

    if (!pricing) {
      pricing = this.pricingRepo.create({
        workspaceId,
      });
    }

    if (config.pricingType !== undefined) {
      pricing.pricingType = config.pricingType;
    }
    if (config.monthlyBasePrice !== undefined) {
      pricing.monthlyBasePrice = config.monthlyBasePrice;
    }
    if (config.monthlyMarkupAmount !== undefined) {
      pricing.monthlyMarkupAmount = config.monthlyMarkupAmount;
    }
    if (config.monthlyMarkupPercentage !== undefined) {
      pricing.monthlyMarkupPercentage = config.monthlyMarkupPercentage;
    }
    if (config.setupFee !== undefined) {
      pricing.setupFee = config.setupFee;
    }
    if (config.allowTenantPurchase !== undefined) {
      pricing.allowTenantPurchase = config.allowTenantPurchase;
    }
    if (config.allowTenantRelease !== undefined) {
      pricing.allowTenantRelease = config.allowTenantRelease;
    }
    if (config.messagingServiceSid !== undefined) {
      pricing.messagingServiceSid = config.messagingServiceSid;
    }

    return this.pricingRepo.save(pricing);
  }

  /**
   * Calculate price for a phone number based on workspace pricing config
   */
  calculatePrice(
    config: PricingConfig,
    country: string,
    twilioCost?: number,
  ): { twilioCost: number; markupAmount: number; totalPrice: number; setupFee: number } {
    const baseCost = twilioCost ?? this.DEFAULT_TWILIO_MONTHLY_COST;

    let markupAmount = 0;
    let totalPrice = 0;

    switch (config.pricingType) {
      case PricingType.FIXED_MARKUP:
        markupAmount = config.monthlyMarkupAmount;
        totalPrice = baseCost + markupAmount;
        break;

      case PricingType.PERCENTAGE_MARKUP:
        markupAmount = baseCost * (config.monthlyMarkupPercentage / 100);
        totalPrice = baseCost + markupAmount;
        break;

      case PricingType.FIXED_PRICE:
        totalPrice = config.monthlyBasePrice ?? baseCost;
        markupAmount = totalPrice - baseCost;
        break;
    }

    return {
      twilioCost: baseCost,
      markupAmount: Math.round(markupAmount * 100) / 100,
      totalPrice: Math.round(totalPrice * 100) / 100,
      setupFee: config.setupFee,
    };
  }

  /**
   * Check if tenant is allowed to purchase numbers
   */
  async canTenantPurchase(workspaceId: string): Promise<boolean> {
    const config = await this.getPricingConfig(workspaceId);
    return config.allowTenantPurchase;
  }

  /**
   * Check if tenant is allowed to release numbers
   */
  async canTenantRelease(workspaceId: string): Promise<boolean> {
    const config = await this.getPricingConfig(workspaceId);
    return config.allowTenantRelease;
  }

  /**
   * Tenant self-service purchase (with permission check)
   */
  async tenantPurchaseNumber(
    workspaceId: string,
    tenantId: string,
    phoneNumber: string,
    friendlyName?: string,
    channel?: 'sms' | 'voice' | 'both',
  ): Promise<PurchaseResult> {
    const canPurchase = await this.canTenantPurchase(workspaceId);
    if (!canPurchase) {
      throw new ForbiddenException('Tenant self-service phone number purchase is not enabled for this workspace');
    }

    return this.purchaseNumber(workspaceId, tenantId, phoneNumber, undefined, friendlyName, channel);
  }

  /**
   * Tenant self-service release (with permission check)
   */
  async tenantReleaseNumber(
    workspaceId: string,
    tenantId: string,
    allocationId: string,
  ): Promise<ReleaseResult> {
    const canRelease = await this.canTenantRelease(workspaceId);
    if (!canRelease) {
      throw new ForbiddenException('Tenant self-service phone number release is not enabled for this workspace');
    }

    return this.releaseNumber(workspaceId, tenantId, allocationId);
  }

  /**
   * Retry A2P Messaging Service attachment for a phone number
   */
  async retryA2PAttachment(
    workspaceId: string,
    allocationId: string,
  ): Promise<{ success: boolean; a2pStatus: string; error?: string }> {
    const allocation = await this.tenantPhoneRepo.findOne({
      where: { id: allocationId, workspaceId },
    });

    if (!allocation) {
      throw new NotFoundException('Phone number allocation not found');
    }

    if (!allocation.provisionedViaCallio || !allocation.providerId) {
      throw new BadRequestException('Can only retry A2P for Callio-provisioned numbers');
    }

    if (allocation.a2pStatus === 'ready') {
      return { success: true, a2pStatus: 'ready' };
    }

    const integration = await this.integrationRepo.findOne({
      where: { workspaceId, provider: ProviderType.TWILIO, status: IntegrationStatus.ACTIVE },
    });

    if (!integration) {
      throw new BadRequestException('No active Twilio integration found');
    }

    const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);
    const result = await this.attachToMessagingService(credentials, allocation.providerId, workspaceId);

    allocation.a2pStatus = result.success ? 'ready' : 'failed';
    allocation.messagingServiceSid = result.messagingServiceSid || allocation.messagingServiceSid;
    if (result.success) {
      allocation.a2pAttachedAt = new Date();
    }
    await this.tenantPhoneRepo.save(allocation);

    return {
      success: result.success,
      a2pStatus: allocation.a2pStatus,
      error: result.error,
    };
  }

  /**
   * Re-configure Twilio webhook URLs for all phone numbers belonging to a tenant.
   * Call this after re-provisioning a tenant so inbound call/SMS webhooks point to the
   * correct Sigcore instance (avoids 404s when the webhook URL has a stale domain).
   */
  async refreshPhoneWebhooks(
    workspaceId: string,
    tenantId: string,
  ): Promise<{ refreshed: number; errors: string[] }> {
    const baseUrl =
      this.configService.get('BASE_URL') ||
      (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);

    if (!baseUrl) {
      this.logger.warn(`[refreshPhoneWebhooks] No BASE_URL configured — skipping for tenant ${tenantId}`);
      return { refreshed: 0, errors: ['BASE_URL not configured'] };
    }

    // Fetch the workspace to get its webhookId (distinct from its UUID).
    // The Twilio voice/SMS webhook handler resolves workspaces by workspace.webhookId,
    // not by workspace.id — using the wrong value causes 404 on inbound calls.
    const workspace = await this.workspaceRepo.findOne({ where: { id: workspaceId } });
    if (!workspace?.webhookId) {
      this.logger.warn(`[refreshPhoneWebhooks] Workspace ${workspaceId} not found or missing webhookId`);
      return { refreshed: 0, errors: ['Workspace not found or missing webhookId'] };
    }

    const integration = await this.integrationRepo.findOne({
      where: { workspaceId, provider: ProviderType.TWILIO, status: IntegrationStatus.ACTIVE },
    });

    if (!integration?.credentialsEncrypted) {
      return { refreshed: 0, errors: ['No active Twilio integration'] };
    }

    const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);
    const allocations = await this.tenantPhoneRepo.find({
      where: { workspaceId, tenantId },
    });

    const smsWebhookUrl = `${baseUrl}/api/webhooks/twilio/sms/${workspace.webhookId}`;
    const voiceWebhookUrl = `${baseUrl}/api/webhooks/twilio/voice/${workspace.webhookId}`;
    let refreshed = 0;
    const errors: string[] = [];

    for (const allocation of allocations) {
      if (!allocation.providerId) continue;
      try {
        await this.twilioProvider.configureWebhooks(credentials, allocation.providerId, smsWebhookUrl, voiceWebhookUrl);
        refreshed++;
        this.logger.log(
          `[refreshPhoneWebhooks] Updated webhooks for ${allocation.phoneNumber} (${allocation.providerId}) → ${voiceWebhookUrl}`,
        );
      } catch (err: any) {
        this.logger.error(`[refreshPhoneWebhooks] Failed for ${allocation.phoneNumber}: ${err.message}`);
        errors.push(`${allocation.phoneNumber}: ${err.message}`);
      }
    }

    return { refreshed, errors };
  }

  /**
   * Set the SMS webhook URL on every Twilio number allocated to a tenant.
   * Unlike refreshPhoneWebhooks, the URL is supplied by the caller and the
   * voice webhook is NOT touched — used by LeadBridge to migrate to the
   * tenant-scoped /webhooks/twilio/sms/lb/:tenantId route (Issue #114).
   *
   * Idempotent. Per-number failures do not abort the loop; each result is
   * reported individually.
   */
  async setSmsWebhookUrl(
    workspaceId: string,
    tenantId: string,
    smsUrl: string,
    smsMethod: string,
  ): Promise<{
    success: boolean;
    results: Array<{ phoneNumberSid: string; updated: boolean; error?: string }>;
  }> {
    const integration = await this.integrationRepo.findOne({
      where: { workspaceId, provider: ProviderType.TWILIO, status: IntegrationStatus.ACTIVE },
    });
    if (!integration?.credentialsEncrypted) {
      this.logger.warn(
        `[setSmsWebhookUrl] No active Twilio integration for workspace=${workspaceId} tenant=${tenantId}`,
      );
      return { success: false, results: [] };
    }

    const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);
    const allocations = await this.tenantPhoneRepo.find({
      where: { workspaceId, tenantId },
    });

    this.logger.log(
      `[setSmsWebhookUrl] tenant=${tenantId} workspace=${workspaceId} ` +
        `numbers=${allocations.length} smsUrl=${smsUrl}`,
    );

    const results: Array<{ phoneNumberSid: string; updated: boolean; error?: string }> = [];

    for (const allocation of allocations) {
      if (!allocation.providerId) {
        this.logger.warn(
          `[setSmsWebhookUrl] Skipping ${allocation.phoneNumber} — missing providerId (Twilio SID)`,
        );
        continue;
      }
      const r = await this.twilioProvider.updateSmsWebhook(
        credentials,
        allocation.providerId,
        smsUrl,
        smsMethod,
      );
      if (r.success) {
        this.logger.log(
          `[setSmsWebhookUrl] OK tenant=${tenantId} sid=${allocation.providerId} ` +
            `phone=${allocation.phoneNumber} smsUrl=${smsUrl}`,
        );
        results.push({ phoneNumberSid: allocation.providerId, updated: true });
      } else {
        this.logger.error(
          `[setSmsWebhookUrl] FAIL tenant=${tenantId} sid=${allocation.providerId} ` +
            `phone=${allocation.phoneNumber} error=${r.error}`,
        );
        results.push({
          phoneNumberSid: allocation.providerId,
          updated: false,
          error: r.error,
        });
      }
    }

    return { success: true, results };
  }

  /**
   * Set the call-forwarding number on a specific phone allocation's metadata.
   * Finds the allocation by phoneNumber across all tenants in the workspace.
   * This is the authoritative way to set callForwardingNumber — handleIncomingCall
   * reads allocation metadata first, so this survives tenant re-provisioning.
   */
  async setPhoneCallForwarding(
    workspaceId: string,
    phoneNumber: string,
    callForwardingNumber: string | null,
  ): Promise<{ phoneNumber: string; callForwardingNumber: string | null }> {
    const allocation = await this.tenantPhoneRepo.findOne({
      where: { workspaceId, phoneNumber },
    });
    if (!allocation) {
      throw new NotFoundException(`Phone number ${phoneNumber} not found in workspace`);
    }
    const meta = { ...(allocation.metadata || {}) };
    if (callForwardingNumber) {
      meta.callForwardingNumber = callForwardingNumber;
    } else {
      delete meta.callForwardingNumber;
    }
    allocation.metadata = meta;
    await this.tenantPhoneRepo.save(allocation);
    this.logger.log(
      `[setPhoneCallForwarding] callForwardingNumber=${callForwardingNumber ?? 'cleared'} on ${phoneNumber} (workspace: ${workspaceId})`,
    );
    return { phoneNumber, callForwardingNumber };
  }

  /**
   * Re-home a phone number allocation to a new tenant within the workspace.
   * Used by LeadBridge when converting a pool number to dedicated — the number
   * was allocated under the platform tenant and must be moved to the real tenant.
   *
   * If no tenant_phone_numbers record exists (e.g. number was in Twilio before Sigcore
   * integration), it is created automatically. The Twilio SID is resolved via the Twilio
   * API and webhooks are configured immediately so inbound calls route correctly.
   *
   * Platform key only.
   */
  async reallocatePhoneNumber(
    workspaceId: string,
    phoneNumber: string,
    newTenantId: string,
  ): Promise<TenantPhoneNumber> {
    const tenant = await this.tenantRepo.findOne({ where: { id: newTenantId, workspaceId } });
    if (!tenant) {
      throw new NotFoundException(`Tenant ${newTenantId} not found in workspace`);
    }

    let allocation = await this.tenantPhoneRepo.findOne({
      where: { workspaceId, phoneNumber },
    });

    if (!allocation) {
      // No record exists — this number was set up outside of Sigcore.
      // Create it now so inbound routing works going forward.
      this.logger.log(
        `[reallocatePhoneNumber] No existing record for ${phoneNumber} in workspace ${workspaceId} — creating`,
      );

      // Resolve the Twilio SID so webhooks can be configured.
      let twilioSid: string | undefined;
      const integration = await this.integrationRepo.findOne({
        where: { workspaceId, provider: ProviderType.TWILIO, status: IntegrationStatus.ACTIVE },
      });
      if (integration?.credentialsEncrypted) {
        const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);
        twilioSid = await this.twilioProvider.getPhoneNumberSid(credentials, phoneNumber);
        if (twilioSid) {
          this.logger.log(`[reallocatePhoneNumber] Resolved Twilio SID ${twilioSid} for ${phoneNumber}`);
        } else {
          this.logger.warn(`[reallocatePhoneNumber] ${phoneNumber} not found in Twilio account — webhooks cannot be auto-configured`);
        }
      } else {
        this.logger.warn(`[reallocatePhoneNumber] No active Twilio integration for workspace ${workspaceId}`);
      }

      allocation = this.tenantPhoneRepo.create({
        workspaceId,
        tenantId: newTenantId,
        phoneNumber,
        providerId: twilioSid,
        provider: PhoneNumberProvider.TWILIO,
        status: PhoneNumberAllocationStatus.ACTIVE,
        provisionedViaCallio: false,
      });
    } else {
      allocation.tenantId = newTenantId;
    }

    await this.tenantPhoneRepo.save(allocation);

    // Wave-3 completion 2026-07-18 — stamp TPN.communication_integration_id
    // for the re-homed row (or for a legacy row that never carried the
    // stamp before). Same rationale as purchaseNumber.
    if (!allocation.communicationIntegrationId) {
      const intId = await this.resolveIntegrationIdForTpnStamp(
        workspaceId, newTenantId, PhoneNumberProvider.TWILIO as unknown as ProviderType,
      );
      if (intId) {
        allocation.communicationIntegrationId = intId;
        await this.tenantPhoneRepo.save(allocation);
      }
    }

    this.logger.log(
      `[reallocatePhoneNumber] ${phoneNumber} re-homed to tenant ${newTenantId} (workspace: ${workspaceId})`,
    );

    // Configure Twilio webhooks immediately so inbound calls/SMS route correctly.
    if (allocation.providerId) {
      try {
        const baseUrl =
          this.configService.get<string>('BASE_URL') ||
          (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);
        const workspace = await this.workspaceRepo.findOne({ where: { id: workspaceId } });

        if (baseUrl && workspace?.webhookId) {
          const integration = await this.integrationRepo.findOne({
            where: { workspaceId, provider: ProviderType.TWILIO, status: IntegrationStatus.ACTIVE },
          });
          if (integration?.credentialsEncrypted) {
            const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);
            const smsWebhookUrl = `${baseUrl}/api/webhooks/twilio/sms/${workspace.webhookId}`;
            const voiceWebhookUrl = `${baseUrl}/api/webhooks/twilio/voice/${workspace.webhookId}`;
            await this.twilioProvider.configureWebhooks(
              credentials,
              allocation.providerId,
              smsWebhookUrl,
              voiceWebhookUrl,
            );
            this.logger.log(
              `[reallocatePhoneNumber] Configured Twilio webhooks for ${phoneNumber} → ${voiceWebhookUrl}`,
            );
          }
        } else {
          this.logger.warn(`[reallocatePhoneNumber] Cannot configure webhooks — BASE_URL or workspace.webhookId missing`);
        }
      } catch (err: any) {
        this.logger.warn(`[reallocatePhoneNumber] Failed to configure Twilio webhooks for ${phoneNumber}: ${err.message}`);
      }
    }

    return allocation;
  }

  /**
   * Attach a phone number to the workspace's Messaging Service with retry
   */
  private async attachToMessagingService(
    credentials: string,
    phoneNumberSid: string,
    workspaceId: string,
    maxRetries = 3,
  ): Promise<{ success: boolean; messagingServiceSid?: string; error?: string }> {
    const pricing = await this.pricingRepo.findOne({ where: { workspaceId } });
    const messagingServiceSid = pricing?.messagingServiceSid;

    if (!messagingServiceSid) {
      this.logger.warn(`No Messaging Service SID configured for workspace ${workspaceId}`);
      return { success: false, error: 'no_messaging_service_configured' };
    }

    let lastError: string | undefined;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const result = await this.twilioProvider.addNumberToMessagingService(
        credentials,
        messagingServiceSid,
        phoneNumberSid,
      );

      if (result.success) {
        return { success: true, messagingServiceSid };
      }

      lastError = result.error;
      this.logger.warn(`A2P attachment attempt ${attempt}/${maxRetries} failed: ${result.error}`);

      // Treat "already exists" as success
      if (result.error?.includes('already exists') || result.error?.includes('21710')) {
        return { success: true, messagingServiceSid };
      }

      // Don't retry non-transient errors
      if (result.error?.includes('not found') || result.error?.includes('invalid')) {
        break;
      }

      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt - 1)));
      }
    }

    return { success: false, messagingServiceSid, error: lastError };
  }
}
