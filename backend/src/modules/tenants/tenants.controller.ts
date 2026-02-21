import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { TenantsService, CreateTenantDto, AllocatePhoneNumberDto, ConnectTenantIntegrationDto } from './tenants.service';
import { PhoneNumberProvisioningService } from './phone-number-provisioning.service';
import { ApiKeysService } from '../api/api-keys.service';
import { SigcoreAuthGuard } from '../auth/sigcore-auth.guard';
import { WorkspaceId } from '../auth/decorators/workspace-id.decorator';
import { TenantStatus } from '../../database/entities/tenant.entity';
import { IntegrationStatus } from '../../database/entities/communication-integration.entity';
import {
  SearchPhoneNumbersDto,
  PurchasePhoneNumberDto,
  UpdatePricingConfigDto,
} from './dto/phone-number-provisioning.dto';

/**
 * Tenants Controller (JWT Auth - for UI/Admin)
 * Manages external clients/tenants and their phone number allocations
 */
@Controller('tenants')
@UseGuards(SigcoreAuthGuard)
export class TenantsController {
  constructor(
    private readonly tenantsService: TenantsService,
    private readonly provisioningService: PhoneNumberProvisioningService,
    private readonly apiKeysService: ApiKeysService,
  ) {}

  // ==================== TENANT MANAGEMENT ====================

  /**
   * Create a new tenant
   * POST /api/tenants
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createTenant(
    @WorkspaceId() workspaceId: string,
    @Body() dto: CreateTenantDto,
  ) {
    const tenant = await this.tenantsService.createTenant(workspaceId, dto);
    return { data: tenant };
  }

  /**
   * Get all tenants
   * GET /api/tenants
   */
  @Get()
  async getTenants(@WorkspaceId() workspaceId: string) {
    const tenants = await this.tenantsService.getTenants(workspaceId);
    return { data: tenants };
  }

  /**
   * Get a specific tenant
   * GET /api/tenants/:id
   */
  @Get(':id')
  async getTenant(
    @WorkspaceId() workspaceId: string,
    @Param('id') tenantId: string,
  ) {
    const tenant = await this.tenantsService.getTenant(workspaceId, tenantId);
    return { data: tenant };
  }

  /**
   * Update a tenant
   * PUT /api/tenants/:id
   */
  @Put(':id')
  async updateTenant(
    @WorkspaceId() workspaceId: string,
    @Param('id') tenantId: string,
    @Body() dto: { name?: string; status?: TenantStatus; metadata?: Record<string, unknown>; webhookUrl?: string; webhookSecret?: string },
  ) {
    const tenant = await this.tenantsService.updateTenant(workspaceId, tenantId, dto);
    return { data: tenant };
  }

  /**
   * Configure webhook for a tenant (for delivery status notifications)
   * PUT /api/tenants/:id/webhook
   *
   * Callio will POST delivery status updates to this URL when messages
   * are delivered, failed, or status changes.
   *
   * Request body:
   * {
   *   "webhookUrl": "https://your-server.com/webhook",
   *   "webhookSecret": "optional-secret-for-signature-verification"
   * }
   */
  @Put(':id/webhook')
  async configureTenantWebhook(
    @WorkspaceId() workspaceId: string,
    @Param('id') tenantId: string,
    @Body() dto: { webhookUrl?: string; webhookSecret?: string },
  ) {
    const tenant = await this.tenantsService.configureWebhook(
      workspaceId,
      tenantId,
      dto.webhookUrl,
      dto.webhookSecret,
    );
    return { data: { webhookUrl: tenant.webhookUrl, webhookConfigured: !!tenant.webhookUrl } };
  }

  /**
   * Get webhook configuration for a tenant
   * GET /api/tenants/:id/webhook
   */
  @Get(':id/webhook')
  async getTenantWebhook(
    @WorkspaceId() workspaceId: string,
    @Param('id') tenantId: string,
  ) {
    const tenant = await this.tenantsService.getTenant(workspaceId, tenantId);
    return {
      data: {
        webhookUrl: tenant.webhookUrl,
        webhookConfigured: !!tenant.webhookUrl,
        hasSecret: !!tenant.webhookSecret,
      },
    };
  }

  /**
   * Delete a tenant
   * DELETE /api/tenants/:id
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteTenant(
    @WorkspaceId() workspaceId: string,
    @Param('id') tenantId: string,
  ) {
    await this.tenantsService.deleteTenant(workspaceId, tenantId);
  }

  // ==================== PHONE NUMBER MANAGEMENT ====================

  /**
   * Get all available phone numbers (from integrations)
   * GET /api/tenants/phone-numbers/available
   */
  @Get('phone-numbers/available')
  async getAvailablePhoneNumbers(@WorkspaceId() workspaceId: string) {
    const phoneNumbers = await this.tenantsService.getAvailablePhoneNumbers(workspaceId);
    return { data: phoneNumbers };
  }

  /**
   * Allocate a phone number to a tenant
   * POST /api/tenants/:id/phone-numbers
   */
  @Post(':id/phone-numbers')
  @HttpCode(HttpStatus.CREATED)
  async allocatePhoneNumber(
    @WorkspaceId() workspaceId: string,
    @Param('id') tenantId: string,
    @Body() dto: Omit<AllocatePhoneNumberDto, 'tenantId'>,
  ) {
    const allocation = await this.tenantsService.allocatePhoneNumber(workspaceId, {
      ...dto,
      tenantId,
    });
    return { data: allocation };
  }

  /**
   * Get phone numbers allocated to a tenant
   * GET /api/tenants/:id/phone-numbers
   */
  @Get(':id/phone-numbers')
  async getTenantPhoneNumbers(
    @WorkspaceId() workspaceId: string,
    @Param('id') tenantId: string,
  ) {
    const phoneNumbers = await this.tenantsService.getTenantPhoneNumbers(workspaceId, tenantId);
    return { data: phoneNumbers };
  }

  /**
   * Deallocate a phone number from a tenant
   * DELETE /api/tenants/:id/phone-numbers/:allocationId
   */
  @Delete(':id/phone-numbers/:allocationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deallocatePhoneNumber(
    @WorkspaceId() workspaceId: string,
    @Param('id') tenantId: string,
    @Param('allocationId') allocationId: string,
  ) {
    await this.tenantsService.deallocatePhoneNumber(workspaceId, allocationId);
  }

  /**
   * Set a phone number as default for a tenant
   * POST /api/tenants/:id/phone-numbers/:allocationId/default
   */
  @Post(':id/phone-numbers/:allocationId/default')
  @HttpCode(HttpStatus.OK)
  async setDefaultPhoneNumber(
    @WorkspaceId() workspaceId: string,
    @Param('id') tenantId: string,
    @Param('allocationId') allocationId: string,
  ) {
    const allocation = await this.tenantsService.setDefaultPhoneNumber(
      workspaceId,
      tenantId,
      allocationId,
    );
    return { data: allocation };
  }

  // ==================== PHONE NUMBER PROVISIONING (Admin) ====================

  /**
   * Search available phone numbers with pricing
   * GET /api/tenants/phone-numbers/search?country=US&areaCode=415
   */
  @Get('phone-numbers/search')
  async searchAvailableNumbers(
    @WorkspaceId() workspaceId: string,
    @Query() query: SearchPhoneNumbersDto,
  ) {
    const numbers = await this.provisioningService.searchAvailableNumbers(
      workspaceId,
      query.country,
      query.areaCode,
      { smsCapable: query.smsCapable, voiceCapable: query.voiceCapable, locality: query.locality, region: query.region },
    );
    return { data: numbers };
  }

  /**
   * Purchase a phone number for a tenant
   * POST /api/tenants/:id/phone-numbers/purchase
   */
  @Post(':id/phone-numbers/purchase')
  @HttpCode(HttpStatus.CREATED)
  async purchasePhoneNumber(
    @WorkspaceId() workspaceId: string,
    @Param('id') tenantId: string,
    @Body() dto: PurchasePhoneNumberDto,
  ) {
    const result = await this.provisioningService.purchaseNumber(
      workspaceId,
      tenantId,
      dto.phoneNumber,
      undefined, // orderedBy - could be extracted from JWT
      dto.friendlyName,
    );
    return { data: result };
  }

  /**
   * Release a provisioned phone number
   * POST /api/tenants/:id/phone-numbers/:allocationId/release
   */
  @Post(':id/phone-numbers/:allocationId/release')
  @HttpCode(HttpStatus.OK)
  async releasePhoneNumber(
    @WorkspaceId() workspaceId: string,
    @Param('id') tenantId: string,
    @Param('allocationId') allocationId: string,
  ) {
    const result = await this.provisioningService.releaseNumber(
      workspaceId,
      tenantId,
      allocationId,
    );
    return { data: result };
  }

  /**
   * Retry A2P Messaging Service attachment for a phone number
   * POST /api/tenants/:id/phone-numbers/:allocationId/retry-a2p
   */
  @Post(':id/phone-numbers/:allocationId/retry-a2p')
  @HttpCode(HttpStatus.OK)
  async retryA2PAttachment(
    @WorkspaceId() workspaceId: string,
    @Param('id') _tenantId: string,
    @Param('allocationId') allocationId: string,
  ) {
    const result = await this.provisioningService.retryA2PAttachment(workspaceId, allocationId);
    return { data: result };
  }

  /**
   * Get order history for a tenant
   * GET /api/tenants/:id/phone-numbers/orders
   */
  @Get(':id/phone-numbers/orders')
  async getTenantOrderHistory(
    @WorkspaceId() workspaceId: string,
    @Param('id') tenantId: string,
  ) {
    const orders = await this.provisioningService.getTenantOrderHistory(workspaceId, tenantId);
    return { data: orders };
  }

  /**
   * Get all phone number orders for the workspace
   * GET /api/tenants/phone-numbers/orders
   */
  @Get('phone-numbers/orders')
  async getWorkspaceOrderHistory(@WorkspaceId() workspaceId: string) {
    const orders = await this.provisioningService.getWorkspaceOrderHistory(workspaceId);
    return { data: orders };
  }

  /**
   * Get pricing configuration
   * GET /api/tenants/pricing
   */
  @Get('pricing')
  async getPricingConfig(@WorkspaceId() workspaceId: string) {
    const config = await this.provisioningService.getPricingConfig(workspaceId);
    return { data: config };
  }

  /**
   * Update pricing configuration
   * PUT /api/tenants/pricing
   */
  @Put('pricing')
  async updatePricingConfig(
    @WorkspaceId() workspaceId: string,
    @Body() dto: UpdatePricingConfigDto,
  ) {
    const config = await this.provisioningService.updatePricingConfig(workspaceId, dto);
    return { data: config };
  }

  // ==================== TENANT API KEYS (Admin) ====================

  /**
   * Create an API key for a tenant
   * POST /api/tenants/:id/api-keys
   */
  @Post(':id/api-keys')
  @HttpCode(HttpStatus.CREATED)
  async createTenantApiKey(
    @WorkspaceId() workspaceId: string,
    @Param('id') tenantId: string,
    @Body() dto: { name: string },
  ) {
    // Verify tenant exists
    await this.tenantsService.getTenant(workspaceId, tenantId);
    const result = await this.apiKeysService.createTenantApiKey(
      workspaceId,
      tenantId,
      dto.name || 'Portal Key',
    );
    return {
      data: {
        id: result.apiKey.id,
        name: result.apiKey.name,
        key: result.key, // Full key shown only on creation
        scope: result.apiKey.scope,
        createdAt: result.apiKey.createdAt,
      },
    };
  }

  /**
   * List API keys for a tenant
   * GET /api/tenants/:id/api-keys
   */
  @Get(':id/api-keys')
  async getTenantApiKeys(
    @WorkspaceId() workspaceId: string,
    @Param('id') tenantId: string,
  ) {
    const keys = await this.apiKeysService.getTenantApiKeys(workspaceId, tenantId);
    return {
      data: keys.map((k) => ({
        id: k.id,
        name: k.name,
        key: k.key,
        keyPreview: `${k.key.substring(0, 16)}...${k.key.substring(k.key.length - 8)}`,
        active: k.active,
        lastUsedAt: k.lastUsedAt,
        createdAt: k.createdAt,
      })),
    };
  }

  /**
   * Revoke a tenant API key
   * DELETE /api/tenants/:id/api-keys/:keyId
   */
  @Delete(':id/api-keys/:keyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteTenantApiKey(
    @WorkspaceId() workspaceId: string,
    @Param('id') tenantId: string,
    @Param('keyId') keyId: string,
  ) {
    await this.apiKeysService.deleteTenantApiKey(workspaceId, tenantId, keyId);
  }

  // ==================== TENANT INTEGRATIONS (Admin) ====================

  /**
   * Connect a provider integration for a tenant (admin creates on behalf of tenant)
   * POST /api/tenants/:id/integrations
   */
  @Post(':id/integrations')
  @HttpCode(HttpStatus.CREATED)
  async connectTenantIntegration(
    @WorkspaceId() workspaceId: string,
    @Param('id') tenantId: string,
    @Body() dto: ConnectTenantIntegrationDto,
  ) {
    const integration = await this.tenantsService.connectTenantIntegration(
      workspaceId,
      tenantId,
      dto,
    );
    return { data: integration };
  }

  /**
   * Get all integrations for a tenant
   * GET /api/tenants/:id/integrations
   */
  @Get(':id/integrations')
  async getTenantIntegrations(
    @WorkspaceId() workspaceId: string,
    @Param('id') tenantId: string,
  ) {
    const integrations = await this.tenantsService.getTenantIntegrations(workspaceId, tenantId);
    return { data: integrations };
  }

  /**
   * Update a tenant integration
   * PUT /api/tenants/:id/integrations/:integrationId
   */
  @Put(':id/integrations/:integrationId')
  async updateTenantIntegration(
    @WorkspaceId() workspaceId: string,
    @Param('id') tenantId: string,
    @Param('integrationId') integrationId: string,
    @Body() dto: {
      phoneNumber?: string;
      phoneNumberSid?: string;
      friendlyName?: string;
      status?: IntegrationStatus;
      metadata?: Record<string, unknown>;
    },
  ) {
    const integration = await this.tenantsService.updateTenantIntegration(
      workspaceId,
      tenantId,
      integrationId,
      dto,
    );
    return { data: integration };
  }

  /**
   * Delete a tenant integration
   * DELETE /api/tenants/:id/integrations/:integrationId
   */
  @Delete(':id/integrations/:integrationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteTenantIntegration(
    @WorkspaceId() workspaceId: string,
    @Param('id') tenantId: string,
    @Param('integrationId') integrationId: string,
  ) {
    await this.tenantsService.deleteTenantIntegration(workspaceId, tenantId, integrationId);
  }
}

/**
 * Tenants V1 API (API Key Auth - for external systems / tenant self-service)
 */
@Controller('v1/tenants')
@UseGuards(SigcoreAuthGuard)
export class TenantsV1Controller {
  constructor(
    private readonly tenantsService: TenantsService,
    private readonly provisioningService: PhoneNumberProvisioningService,
  ) {}

  /**
   * Get tenant by external ID
   * GET /api/v1/tenants/by-external-id?externalId=xxx
   */
  @Get('by-external-id')
  async getTenantByExternalId(
    @WorkspaceId() workspaceId: string,
    @Query('externalId') externalId: string,
  ) {
    const tenant = await this.tenantsService.getTenantByExternalId(workspaceId, externalId);
    return { data: tenant };
  }

  /**
   * Get phone numbers for a tenant by external ID
   * GET /api/v1/tenants/by-external-id/phone-numbers?externalId=xxx
   */
  @Get('by-external-id/phone-numbers')
  async getTenantPhoneNumbersByExternalId(
    @WorkspaceId() workspaceId: string,
    @Query('externalId') externalId: string,
  ) {
    const tenant = await this.tenantsService.getTenantByExternalId(workspaceId, externalId);
    if (!tenant) {
      return { data: [] };
    }
    const phoneNumbers = await this.tenantsService.getTenantPhoneNumbers(workspaceId, tenant.id);
    return { data: phoneNumbers };
  }

  /**
   * Get default phone number for a tenant
   * GET /api/v1/tenants/:tenantId/default-phone-number
   */
  @Get(':tenantId/default-phone-number')
  async getDefaultPhoneNumber(
    @WorkspaceId() workspaceId: string,
    @Param('tenantId') tenantId: string,
  ) {
    const phoneNumber = await this.tenantsService.getTenantDefaultPhoneNumber(workspaceId, tenantId);
    return { data: phoneNumber };
  }

  // ==================== TENANT INTEGRATIONS (External API) ====================

  /**
   * Connect tenant's own provider integration (tenant provides their own credentials)
   * POST /api/v1/tenants/:tenantId/integrations
   *
   * Body for Twilio:
   * {
   *   "provider": "twilio",
   *   "accountSid": "ACxxx",
   *   "authToken": "xxx",
   *   "phoneNumber": "+15551234567" (optional)
   * }
   *
   * Body for OpenPhone:
   * {
   *   "provider": "openphone",
   *   "apiKey": "xxx"
   * }
   */
  @Post(':tenantId/integrations')
  @HttpCode(HttpStatus.CREATED)
  async connectIntegration(
    @WorkspaceId() workspaceId: string,
    @Param('tenantId') tenantId: string,
    @Body() dto: ConnectTenantIntegrationDto,
  ) {
    const integration = await this.tenantsService.connectTenantIntegration(
      workspaceId,
      tenantId,
      dto,
    );
    // Return without encrypted credentials
    return {
      data: {
        id: integration.id,
        provider: integration.provider,
        status: integration.status,
        phoneNumber: integration.phoneNumber,
        friendlyName: integration.friendlyName,
        createdAt: integration.createdAt,
      },
    };
  }

  /**
   * Get tenant's integrations
   * GET /api/v1/tenants/:tenantId/integrations
   */
  @Get(':tenantId/integrations')
  async getIntegrations(
    @WorkspaceId() workspaceId: string,
    @Param('tenantId') tenantId: string,
  ) {
    const integrations = await this.tenantsService.getTenantIntegrations(workspaceId, tenantId);
    // Return without encrypted credentials
    return {
      data: integrations.map((i) => ({
        id: i.id,
        provider: i.provider,
        status: i.status,
        phoneNumber: i.phoneNumber,
        friendlyName: i.friendlyName,
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
      })),
    };
  }

  /**
   * Delete tenant's integration
   * DELETE /api/v1/tenants/:tenantId/integrations/:integrationId
   */
  @Delete(':tenantId/integrations/:integrationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteIntegration(
    @WorkspaceId() workspaceId: string,
    @Param('tenantId') tenantId: string,
    @Param('integrationId') integrationId: string,
  ) {
    await this.tenantsService.deleteTenantIntegration(workspaceId, tenantId, integrationId);
  }

  // ==================== PHONE NUMBER PROVISIONING (Tenant Self-Service) ====================

  /**
   * Get pricing information for phone numbers
   * GET /api/v1/tenants/phone-numbers/pricing
   */
  @Get('phone-numbers/pricing')
  async getPricingInfo(@WorkspaceId() workspaceId: string) {
    const config = await this.provisioningService.getPricingConfig(workspaceId);
    return {
      data: {
        pricingType: config.pricingType,
        setupFee: config.setupFee,
        allowTenantPurchase: config.allowTenantPurchase,
        allowTenantRelease: config.allowTenantRelease,
        // Note: exact pricing shown in search results
      },
    };
  }

  /**
   * Search available phone numbers with pricing
   * GET /api/v1/tenants/phone-numbers/search?country=US&areaCode=415
   */
  @Get('phone-numbers/search')
  async searchAvailableNumbers(
    @WorkspaceId() workspaceId: string,
    @Query() query: SearchPhoneNumbersDto,
  ) {
    const numbers = await this.provisioningService.searchAvailableNumbers(
      workspaceId,
      query.country,
      query.areaCode,
      { smsCapable: query.smsCapable, voiceCapable: query.voiceCapable, locality: query.locality, region: query.region },
    );
    return { data: numbers };
  }

  /**
   * Purchase a phone number (tenant self-service)
   * POST /api/v1/tenants/:tenantId/phone-numbers/purchase
   * Only available if allowTenantPurchase is enabled
   */
  @Post(':tenantId/phone-numbers/purchase')
  @HttpCode(HttpStatus.CREATED)
  async purchasePhoneNumber(
    @WorkspaceId() workspaceId: string,
    @Param('tenantId') tenantId: string,
    @Body() dto: PurchasePhoneNumberDto,
  ) {
    const result = await this.provisioningService.tenantPurchaseNumber(
      workspaceId,
      tenantId,
      dto.phoneNumber,
      dto.friendlyName,
    );
    return { data: result };
  }

  /**
   * Release a provisioned phone number (tenant self-service)
   * POST /api/v1/tenants/:tenantId/phone-numbers/:allocationId/release
   * Only available if allowTenantRelease is enabled
   */
  @Post(':tenantId/phone-numbers/:allocationId/release')
  @HttpCode(HttpStatus.OK)
  async releasePhoneNumber(
    @WorkspaceId() workspaceId: string,
    @Param('tenantId') tenantId: string,
    @Param('allocationId') allocationId: string,
  ) {
    const result = await this.provisioningService.tenantReleaseNumber(
      workspaceId,
      tenantId,
      allocationId,
    );
    return { data: result };
  }

  /**
   * Get order history for a tenant
   * GET /api/v1/tenants/:tenantId/phone-numbers/orders
   */
  @Get(':tenantId/phone-numbers/orders')
  async getTenantOrderHistory(
    @WorkspaceId() workspaceId: string,
    @Param('tenantId') tenantId: string,
  ) {
    const orders = await this.provisioningService.getTenantOrderHistory(workspaceId, tenantId);
    return { data: orders };
  }

  /**
   * Update pricing configuration
   * PUT /api/v1/tenants/phone-numbers/pricing
   */
  @Put('phone-numbers/pricing')
  async updatePricingConfig(
    @WorkspaceId() workspaceId: string,
    @Body() dto: UpdatePricingConfigDto,
  ) {
    const pricing = await this.provisioningService.updatePricingConfig(workspaceId, dto);
    return { data: pricing };
  }

  // ==================== WEBHOOK CONFIGURATION (External API) ====================

  /**
   * Configure webhook for delivery status notifications
   * PUT /api/v1/tenants/:tenantId/webhook
   *
   * Callio will POST delivery status updates to this URL when messages
   * are delivered, failed, or status changes.
   *
   * Request body:
   * {
   *   "webhookUrl": "https://your-server.com/webhook",
   *   "webhookSecret": "optional-secret-for-signature-verification"
   * }
   *
   * Webhook payload format:
   * {
   *   "event": "message.delivered" | "message.failed" | "message.status_update",
   *   "timestamp": "2024-01-24T10:30:00.000Z",
   *   "data": {
   *     "messageId": "uuid",
   *     "providerMessageId": "SM...",
   *     "status": "delivered" | "failed" | "sent" | "pending",
   *     "fromNumber": "+15551234567",
   *     "toNumber": "+15559876543",
   *     "tenantId": "uuid",
   *     "leadId": "external-lead-id",
   *     "errorCode": "optional",
   *     "errorMessage": "optional"
   *   }
   * }
   *
   * Headers:
   * - X-Callio-Event: The event type
   * - X-Callio-Timestamp: ISO timestamp
   * - X-Callio-Tenant-Id: Your tenant ID
   * - X-Callio-Signature: HMAC-SHA256 signature (if webhookSecret configured)
   */
  @Put(':tenantId/webhook')
  async configureWebhook(
    @WorkspaceId() workspaceId: string,
    @Param('tenantId') tenantId: string,
    @Body() dto: { webhookUrl?: string; webhookSecret?: string },
  ) {
    const tenant = await this.tenantsService.configureWebhook(
      workspaceId,
      tenantId,
      dto.webhookUrl,
      dto.webhookSecret,
    );
    return {
      data: {
        webhookUrl: tenant.webhookUrl,
        webhookConfigured: !!tenant.webhookUrl,
      },
    };
  }

  /**
   * Get webhook configuration
   * GET /api/v1/tenants/:tenantId/webhook
   */
  @Get(':tenantId/webhook')
  async getWebhook(
    @WorkspaceId() workspaceId: string,
    @Param('tenantId') tenantId: string,
  ) {
    const tenant = await this.tenantsService.getTenant(workspaceId, tenantId);
    return {
      data: {
        webhookUrl: tenant.webhookUrl,
        webhookConfigured: !!tenant.webhookUrl,
        hasSecret: !!tenant.webhookSecret,
      },
    };
  }
}
