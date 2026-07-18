import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Tenant } from '../../database/entities/tenant.entity';
import {
  CommunicationIntegration,
  IntegrationStatus,
  ProviderType,
} from '../../database/entities/communication-integration.entity';
import {
  TenantPhoneNumber,
  PhoneNumberAllocationStatus,
} from '../../database/entities/tenant-phone-number.entity';
import { CommunicationBusiness } from '../../database/entities/communication-business.entity';
import { CommunicationProfile } from '../../database/entities/communication-profile.entity';
import {
  ProfilePhoneAssignment,
} from '../../database/entities/profile-phone-assignment.entity';
import {
  WebhookSubscription,
  WebhookSubscriptionStatus,
  WebhookEventType,
} from '../../database/entities/webhook-subscription.entity';
import { ApiKey } from '../../database/entities/api-key.entity';
import {
  ensureOutboundReadyForTenantPhone,
  TenantSignals,
} from './ensure-outbound-ready.helpers';

/**
 * Wave-3 completion 2026-07-18 — communication-ready provisioning.
 *
 * A newly provisioned Sigcore tenant used to leave `POST /tenants/provision`
 * with nothing but a `tenants` row + API key. Every downstream comm-chain
 * table (business, profile, PPA, TPN stamp, webhook subscription) had to
 * be populated by separate calls. Two incidents rediscovered this the
 * hard way:
 *
 *   - 2026-07-13: Spotless — five re-provisioned tenants missed their
 *     profile+PPA chain and every outbound send 422'd on
 *     `INVALID_PROFILE_PHONE` for two days before anyone noticed.
 *
 *   - 2026-07-18: Natallia — TPN provisioned via Callio never got its
 *     `communication_integration_id` stamped, so the resolver's rule 1
 *     fell through and hit rule-4 ambiguity → 409.
 *
 * This service exists so **one provision call leaves the tenant in a
 * communication-ready state**. Idempotent; safe to re-run on partial
 * state. Reuses `ensureOutboundReadyForTenantPhone` for the business /
 * profile / PPA chain — the invariant lives in exactly one place, not
 * scattered across nine TPN-write paths.
 *
 * The integration side is **assertion-only** (does not create rows).
 * A tenant in a shared workspace uses the workspace-scoped integration;
 * a tenant with its own subaccount uses its tenant-scoped integration.
 * Both are set up out-of-band via `POST /v1/integrations/ensure` or the
 * setup* admin flows, both gated on the ownership guard. This service
 * verifies the integration exists — it never creates one, which is the
 * exact bypass PR-B closed for the three setup* paths.
 */

export type CommunicationReadinessReason =
  | 'ready'
  | 'no_integration'
  | 'no_business'
  | 'no_profile'
  | 'no_ppa_for_active_tpn'
  | 'no_active_tpn';

export interface CommunicationReadinessReport {
  tenant: true;
  integration: {
    present: boolean;
    id: string | null;
    scopeType: 'WORKSPACE' | 'TENANT' | 'SYSTEM' | null;
    ownerTenantId: string | null;
  };
  business: { present: boolean; id: string | null };
  profile: { present: boolean; id: string | null };
  ppa: { present: boolean; id: string | null };
  webhookSubscription: { present: boolean; id: string | null };
  activeTpn: {
    present: boolean;
    id: string | null;
    phoneNumber: string | null;
    communicationIntegrationId: string | null;
  };
  /** Machine-readable reason for the readiness state — 'ready' iff everything's present. */
  reason: CommunicationReadinessReason;
}

export interface ProvisionCommunicationChainInput {
  /** default TWILIO — the only provider currently supported by this service. */
  provider?: ProviderType;
  /**
   * When supplied, an existing TPN with this phone (owned by this tenant
   * in this workspace) is linked into the chain and stamped. When absent,
   * only the business + profile are ensured.
   */
  phoneNumber?: string;
  /** Alternative to phoneNumber — supply the TPN id directly. */
  tenantPhoneNumberId?: string;
  /** Optional — register a webhook subscription in one shot. */
  webhook?: {
    url: string;
    events?: WebhookEventType[];
    payloadVersion?: 'v1' | 'v2';
    secret?: string;
  };
}

export interface ProvisionCommunicationChainResult {
  integration: {
    id: string | null;
    scopeType: string | null;
    ownerTenantId: string | null;
  };
  business: { id: string; created: boolean };
  profile: { id: string; created: boolean };
  ppa: { id: string | null; created: boolean };
  webhookSubscription: { id: string | null; created: boolean };
}

@Injectable()
export class CommunicationProvisioningService {
  private readonly logger = new Logger(CommunicationProvisioningService.name);

  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    @InjectRepository(CommunicationIntegration)
    private readonly integrationRepo: Repository<CommunicationIntegration>,
    @InjectRepository(TenantPhoneNumber)
    private readonly tpnRepo: Repository<TenantPhoneNumber>,
    @InjectRepository(CommunicationBusiness)
    private readonly businessRepo: Repository<CommunicationBusiness>,
    @InjectRepository(CommunicationProfile)
    private readonly profileRepo: Repository<CommunicationProfile>,
    @InjectRepository(ProfilePhoneAssignment)
    private readonly ppaRepo: Repository<ProfilePhoneAssignment>,
    @InjectRepository(WebhookSubscription)
    private readonly webhookRepo: Repository<WebhookSubscription>,
    @InjectRepository(ApiKey)
    private readonly apiKeyRepo: Repository<ApiKey>,
  ) {}

  /**
   * Idempotently ensure the tenant's outbound-resolution chain exists.
   * Safe to re-run on partial state (heals what's missing, leaves what's
   * already correct).
   */
  async provisionCommunicationChain(
    tenant: Tenant,
    input: ProvisionCommunicationChainInput = {},
  ): Promise<ProvisionCommunicationChainResult> {
    const provider = input.provider ?? ProviderType.TWILIO;

    // 1. Integration — assertion-only (see class comment). Returns the row
    //    that would resolve for this tenant so the response can carry it,
    //    but never creates a new row.
    const integration = await this.resolveIntegrationForTenant(
      tenant.workspaceId,
      tenant.id,
      provider,
    );

    // 2. Locate the TPN if the caller supplied phone details. Optional —
    //    tenants provisioned before their number is purchased still get a
    //    business + default profile so the chain is ready for the next
    //    phone-purchase call.
    let tpn: TenantPhoneNumber | null = null;
    if (input.tenantPhoneNumberId) {
      tpn = await this.tpnRepo.findOne({
        where: {
          id: input.tenantPhoneNumberId,
          workspaceId: tenant.workspaceId,
          tenantId: tenant.id,
        },
      });
      if (!tpn) {
        throw new NotFoundException(
          `TPN ${input.tenantPhoneNumberId} not found for tenant ${tenant.id}`,
        );
      }
    } else if (input.phoneNumber) {
      tpn = await this.tpnRepo.findOne({
        where: {
          workspaceId: tenant.workspaceId,
          tenantId: tenant.id,
          phoneNumber: input.phoneNumber,
        },
      });
      if (!tpn) {
        throw new NotFoundException(
          `TPN ${input.phoneNumber} not found for tenant ${tenant.id} — purchase the number first`,
        );
      }
    }

    // 3. Business + profile + PPA chain — via the shared helper.
    // When no TPN is supplied, we still want the business + profile so a
    // future phone purchase's `ensureOutboundReady` finds the chain
    // already prepared. Pass a stub TPN with a NULL id in that case —
    // ensureOutboundReadyForTenantPhone tolerates it: the PPA step is
    // skipped because there's no TPN id to link.
    const signals = await this.collectTenantSignals(tenant);
    let businessResult: {
      businessId: string;
      profileId: string;
      ppaId: string | null;
      changed: boolean;
    };
    if (tpn) {
      const res = await ensureOutboundReadyForTenantPhone(
        {
          business: this.businessRepo,
          profile: this.profileRepo,
          ppa: this.ppaRepo,
        },
        tpn,
        signals,
      );
      businessResult = { ...res, ppaId: res.ppaId };

      // Stamp the TPN with the integration if unstamped. Same helper the
      // purchase path uses (see PhoneNumberProvisioningService). Missing
      // integration is logged, not thrown — a data-completion issue must
      // never roll back tenant provisioning.
      if (!tpn.communicationIntegrationId && integration) {
        tpn.communicationIntegrationId = integration.id;
        await this.tpnRepo.save(tpn);
      }
    } else {
      businessResult = await this.ensureBusinessAndProfileWithoutTpn(
        tenant,
        signals,
      );
    }

    // 4. Optional webhook subscription.
    let webhookSubscription: { id: string | null; created: boolean } = {
      id: null,
      created: false,
    };
    if (input.webhook?.url) {
      webhookSubscription = await this.ensureWebhookSubscription(
        tenant,
        input.webhook,
      );
    }

    return {
      integration: {
        id: integration?.id ?? null,
        scopeType: integration?.scopeType ?? null,
        ownerTenantId: integration?.ownerTenantId ?? null,
      },
      business: { id: businessResult.businessId, created: businessResult.changed },
      profile: { id: businessResult.profileId, created: businessResult.changed },
      ppa: {
        id: businessResult.ppaId,
        created: businessResult.changed && !!businessResult.ppaId,
      },
      webhookSubscription,
    };
  }

  /**
   * Report the tenant's readiness across every chain the outbound
   * resolver walks. Used by `GET /tenants/:id/communication-readiness`
   * and by CI's post-deploy check.
   */
  async getReadiness(tenant: Tenant): Promise<CommunicationReadinessReport> {
    const integration = await this.resolveIntegrationForTenant(
      tenant.workspaceId,
      tenant.id,
      ProviderType.TWILIO,
    );
    const business = await this.businessRepo.findOne({
      where: { tenantId: tenant.id },
    });
    const profile = await this.profileRepo.findOne({
      where: { tenantId: tenant.id, slug: 'default' },
    });
    const activeTpn = await this.tpnRepo.findOne({
      where: {
        tenantId: tenant.id,
        workspaceId: tenant.workspaceId,
        status: PhoneNumberAllocationStatus.ACTIVE,
      },
    });
    let ppa: ProfilePhoneAssignment | null = null;
    if (profile && activeTpn) {
      ppa = await this.ppaRepo.findOne({
        where: {
          profileId: profile.id,
          tenantPhoneNumberId: activeTpn.id,
          active: true,
        },
      });
    }
    const webhook = await this.webhookRepo.findOne({
      where: {
        workspaceId: tenant.workspaceId,
        tenantId: tenant.id,
        status: WebhookSubscriptionStatus.ACTIVE,
      },
    });

    // Determine the primary readiness reason. Order matters — return the
    // FIRST missing link so callers know what to fix next.
    let reason: CommunicationReadinessReason = 'ready';
    if (!integration) reason = 'no_integration';
    else if (!business) reason = 'no_business';
    else if (!profile) reason = 'no_profile';
    else if (!activeTpn) reason = 'no_active_tpn';
    else if (!ppa) reason = 'no_ppa_for_active_tpn';

    return {
      tenant: true,
      integration: {
        present: !!integration,
        id: integration?.id ?? null,
        scopeType: (integration?.scopeType as any) ?? null,
        ownerTenantId: integration?.ownerTenantId ?? null,
      },
      business: { present: !!business, id: business?.id ?? null },
      profile: { present: !!profile, id: profile?.id ?? null },
      ppa: { present: !!ppa, id: ppa?.id ?? null },
      webhookSubscription: { present: !!webhook, id: webhook?.id ?? null },
      activeTpn: {
        present: !!activeTpn,
        id: activeTpn?.id ?? null,
        phoneNumber: activeTpn?.phoneNumber ?? null,
        communicationIntegrationId:
          activeTpn?.communicationIntegrationId ?? null,
      },
      reason,
    };
  }

  // --------------------------------------------------------------------

  /**
   * Mirror of the resolver's rule 3 → rule 4 without throwing: return
   * the integration that would resolve for this tenant, or null.
   */
  private async resolveIntegrationForTenant(
    workspaceId: string,
    tenantId: string,
    provider: ProviderType,
  ): Promise<CommunicationIntegration | null> {
    const tenantScoped = await this.integrationRepo.findOne({
      where: {
        workspaceId,
        provider,
        scopeType: 'TENANT',
        ownerTenantId: tenantId,
        status: IntegrationStatus.ACTIVE,
      },
    });
    if (tenantScoped) return tenantScoped;

    const workspaceScoped = await this.integrationRepo.findOne({
      where: {
        workspaceId,
        provider,
        ownerTenantId: IsNull(),
        status: IntegrationStatus.ACTIVE,
      },
    });
    return workspaceScoped ?? null;
  }

  private async collectTenantSignals(tenant: Tenant): Promise<TenantSignals> {
    const webhookRows = await this.webhookRepo.find({
      where: { workspaceId: tenant.workspaceId, tenantId: tenant.id },
      select: ['webhookUrl'],
    });
    const apiKeyRows = await this.apiKeyRepo.find({
      where: { workspaceId: tenant.workspaceId, tenantId: tenant.id },
      select: ['name'],
    });
    return {
      name: tenant.name ?? null,
      externalId: (tenant.externalId as string | null) ?? null,
      webhookUrls: webhookRows.map((r) => r.webhookUrl).filter(Boolean),
      apiKeyNames: apiKeyRows.map((r) => r.name).filter(Boolean),
    };
  }

  /**
   * Business + default profile without a TPN — used when the tenant
   * provisions before its number is purchased. Prepares the chain so the
   * subsequent `PhoneNumberProvisioningService.purchaseNumber` completes
   * the last step (PPA) via `ensureOutboundReady`. Idempotent.
   */
  private async ensureBusinessAndProfileWithoutTpn(
    tenant: Tenant,
    signals: TenantSignals,
  ): Promise<{
    businessId: string;
    profileId: string;
    ppaId: string | null;
    changed: boolean;
  }> {
    const {
      classifyTenantSource,
      makeSlug,
    } = await import('../../database/migrations/_helpers/source-classifier');
    const source = classifyTenantSource(
      signals.name,
      signals.webhookUrls,
      signals.apiKeyNames,
    );
    const slug = makeSlug(signals.name, tenant.id);
    const displayName =
      (signals.name ?? '').trim() || `Workspace ${tenant.id.slice(0, 8)}`;
    const externalBusinessId =
      source === 'leadbridge' ? signals.externalId ?? null : null;

    let changed = false;

    let business = await this.businessRepo.findOne({
      where: { tenantId: tenant.id, slug },
    });
    if (!business) {
      business = await this.businessRepo.save(
        this.businessRepo.create({
          workspaceId: tenant.workspaceId,
          tenantId: tenant.id,
          externalBusinessId: externalBusinessId as any,
          displayName,
          slug,
          status: 'active',
        }),
      );
      changed = true;
    }

    let profile = await this.profileRepo.findOne({
      where: { communicationBusinessId: business.id, slug: 'default' },
    });
    if (!profile) {
      profile = await this.profileRepo.save(
        this.profileRepo.create({
          workspaceId: tenant.workspaceId,
          tenantId: tenant.id,
          communicationBusinessId: business.id,
          source,
          displayName: 'Default',
          slug: 'default',
          status: 'active',
          isDefault: true,
        }),
      );
      changed = true;
    }

    if (business.defaultProfileId !== profile.id) {
      business.defaultProfileId = profile.id;
      await this.businessRepo.save(business);
      changed = true;
    }

    return { businessId: business.id, profileId: profile.id, ppaId: null, changed };
  }

  /**
   * Idempotent webhook subscription create-or-return. Match key:
   * (workspaceId, tenantId, webhookUrl). Callers that need to update
   * events after the fact use the existing webhook-subscriptions PATCH
   * endpoint — this method is for the "first-time provision" case.
   */
  private async ensureWebhookSubscription(
    tenant: Tenant,
    webhook: NonNullable<ProvisionCommunicationChainInput['webhook']>,
  ): Promise<{ id: string; created: boolean }> {
    const existing = await this.webhookRepo.findOne({
      where: {
        workspaceId: tenant.workspaceId,
        tenantId: tenant.id,
        webhookUrl: webhook.url,
      },
    });
    if (existing) return { id: existing.id, created: false };

    if (!webhook.url.startsWith('https://') && !webhook.url.startsWith('http://')) {
      throw new BadRequestException('webhook.url must be http(s)://');
    }

    const defaultEvents: WebhookEventType[] = [
      WebhookEventType.MESSAGE_INBOUND,
      WebhookEventType.MESSAGE_DELIVERED,
      WebhookEventType.MESSAGE_FAILED,
      WebhookEventType.MESSAGE_SENT,
    ];

    const saved = await this.webhookRepo.save(
      this.webhookRepo.create({
        workspaceId: tenant.workspaceId,
        tenantId: tenant.id,
        name: `${tenant.name ?? tenant.id.slice(0, 8)} default`,
        webhookUrl: webhook.url,
        secret: webhook.secret,
        payloadVersion: webhook.payloadVersion ?? 'v2',
        events: webhook.events?.length ? webhook.events : defaultEvents,
        status: WebhookSubscriptionStatus.ACTIVE,
      }),
    );
    return { id: saved.id, created: true };
  }
}
