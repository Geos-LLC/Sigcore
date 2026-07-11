import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
import { ensureOutboundReadyForTenantPhone } from './ensure-outbound-ready.helpers';

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
  ) {}

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

      // Purchase from Twilio
      const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);
      const purchased = await this.twilioProvider.purchasePhoneNumber(credentials, phoneNumber);

      order.phoneNumberSid = purchased.sid;
      order.metadata = {
        ...order.metadata,
        capabilities: purchased.capabilities,
        friendlyName: purchased.friendlyName,
      };

      // Configure webhooks on the new number
      const baseUrl = this.configService.get('BASE_URL') || process.env.BASE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);
      if (baseUrl) {
        // Use workspaceId as the webhookId for Twilio webhooks
        const smsWebhookUrl = `${baseUrl}/api/webhooks/twilio/sms/${workspaceId}`;
        const voiceWebhookUrl = `${baseUrl}/api/webhooks/twilio/voice/${workspaceId}`;

        await this.twilioProvider.configureWebhooks(
          credentials,
          purchased.sid,
          smsWebhookUrl,
          voiceWebhookUrl,
        );
      }

      // Attach to Messaging Service for A2P 10DLC compliance
      let a2pStatus: string | undefined = undefined;
      let a2pMessagingServiceSid: string | undefined;
      let a2pAttachedAt: Date | undefined;

      if (purchased.capabilities?.includes('sms')) {
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

      // Allocate to tenant
      const allocation = this.tenantPhoneRepo.create({
        workspaceId,
        tenantId,
        phoneNumber: purchased.phoneNumber,
        friendlyName: friendlyName || purchased.friendlyName,
        provider: PhoneNumberProvider.TWILIO,
        providerId: purchased.sid,
        channel: ChannelType.SMS,
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
        },
      });
      await this.tenantPhoneRepo.save(allocation);

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

      return {
        success: false,
        order,
        error: error.message,
      };
    }
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

    if (!allocation.provisionedViaCallio) {
      throw new BadRequestException('Cannot release a number that was not provisioned through Callio');
    }

    // Get Twilio integration
    const integration = await this.integrationRepo.findOne({
      where: { workspaceId, provider: ProviderType.TWILIO, status: IntegrationStatus.ACTIVE },
    });

    if (!integration) {
      throw new BadRequestException('No active Twilio integration found');
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

      // Release from Twilio
      await this.twilioProvider.releasePhoneNumber(credentials, allocation.providerId!);

      // Deallocate from tenant
      await this.tenantPhoneRepo.remove(allocation);

      // Update order
      order.status = PhoneNumberOrderStatus.RELEASED;
      order.completedAt = new Date();
      order.tenantPhoneNumberId = undefined; // Allocation no longer exists
      await this.orderRepo.save(order);

      this.logger.log(`Successfully released ${allocation.phoneNumber} from tenant ${tenantId}`);

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
  ): Promise<PurchaseResult> {
    const canPurchase = await this.canTenantPurchase(workspaceId);
    if (!canPurchase) {
      throw new ForbiddenException('Tenant self-service phone number purchase is not enabled for this workspace');
    }

    return this.purchaseNumber(workspaceId, tenantId, phoneNumber, undefined, friendlyName);
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
