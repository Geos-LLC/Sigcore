import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  Request,
  ForbiddenException,
} from '@nestjs/common';
import { TenantsService, CreateTenantDto, AllocatePhoneNumberDto, ConnectTenantIntegrationDto } from './tenants.service';
import { PhoneNumberProvisioningService } from './phone-number-provisioning.service';
import { ApiKeysService } from '../api/api-keys.service';
import { CommunicationService } from '../communication/communication.service';
import { SigcoreAuthGuard } from '../auth/sigcore-auth.guard';
import { WorkspaceId, TenantId } from '../auth/decorators/workspace-id.decorator';
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
    private readonly communicationService: CommunicationService,
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
   * Provision a tenant + tenant API key in one call (idempotent by externalTenantId).
   * Called by LeadBridge using the workspace key to set up per-account isolation.
   * POST /api/tenants/provision
   */
  @Post('provision')
  @HttpCode(HttpStatus.OK)
  async provisionTenant(
    @WorkspaceId() workspaceId: string,
    @Request() req: any,
    @Body() dto: { externalTenantId: string; displayName?: string },
  ) {
    if (req.apiKeyScope === 'tenant') {
      throw new ForbiddenException('Tenant keys cannot provision tenants');
    }
    let tenant = await this.tenantsService.getTenantByExternalId(workspaceId, dto.externalTenantId);
    let isNew = false;
    if (!tenant) {
      tenant = await this.tenantsService.createTenant(workspaceId, {
        externalId: dto.externalTenantId,
        name: dto.displayName || dto.externalTenantId,
      });
      isNew = true;
    }
    const result = await this.apiKeysService.createTenantApiKey(workspaceId, tenant.id, 'LeadBridge Key');
    return {
      data: {
        tenantId: tenant.id,
        externalTenantId: tenant.externalId,
        apiKey: result.key,
        isNew,
      },
    };
  }

  /**
   * Copy integrations from another tenant (used during re-provisioning shared tenants).
   * POST /api/tenants/:tenantId/copy-integrations
   */
  @Post(':tenantId/copy-integrations')
  @HttpCode(HttpStatus.OK)
  async copyIntegrations(
    @WorkspaceId() workspaceId: string,
    @Request() req: any,
    @Param('tenantId') tenantId: string,
    @Body() dto: { fromTenantId: string },
  ) {
    if (req.apiKeyScope === 'tenant') {
      throw new ForbiddenException('Tenant keys cannot copy integrations');
    }
    const result = await this.tenantsService.copyTenantIntegrations(workspaceId, dto.fromTenantId, tenantId);
    return { data: result };
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

  // ==================== SYNC MONITOR ====================

  /**
   * Get sync status for the workspace.
   * GET /api/tenants/sync/status
   */
  @Get('sync/status')
  async getSyncStatus(@WorkspaceId() workspaceId: string) {
    const status = this.communicationService.getSyncStatus(workspaceId);
    return { data: status };
  }

  /**
   * Get all tenants with their integrations — for sync monitor overview.
   * GET /api/tenants/sync/overview
   */
  @Get('sync/overview')
  async getSyncOverview(@WorkspaceId() workspaceId: string) {
    const tenants = await this.tenantsService.getTenants(workspaceId);
    const overview = [];

    for (const tenant of tenants) {
      const integrations = await this.tenantsService.getTenantIntegrations(workspaceId, tenant.id);
      overview.push({
        id: tenant.id,
        externalId: tenant.externalId,
        name: tenant.name,
        status: tenant.status,
        phoneNumbers: (tenant.phoneNumbers || []).map(pn => ({
          id: pn.id,
          phoneNumber: pn.phoneNumber,
          provider: pn.provider,
          friendlyName: pn.friendlyName,
        })),
        integrations: integrations.map(i => ({
          id: i.id,
          provider: i.provider,
          status: i.status,
        })),
        createdAt: tenant.createdAt,
      });
    }

    const syncStatus = this.communicationService.getSyncStatus(workspaceId);
    return { data: { tenants: overview, syncStatus } };
  }

  /**
   * Trigger sync for the workspace.
   * POST /api/tenants/sync/trigger
   */
  @Post('sync/trigger')
  @HttpCode(HttpStatus.ACCEPTED)
  async triggerSync(
    @WorkspaceId() workspaceId: string,
    @TenantId() tenantId: string | null,
    @Body() options?: { syncMessages?: boolean; provider?: string; limit?: number },
  ) {
    this.communicationService.syncConversations(workspaceId, {
      syncMessages: options?.syncMessages ?? true,
      provider: options?.provider as any,
      limit: options?.limit,
      tenantId,
    }).catch(err => {
      console.error('Background sync error:', err);
    });

    return { data: { started: true, message: 'Sync started. Poll /tenants/sync/status for progress.' } };
  }

  /**
   * Cancel running sync.
   * POST /api/tenants/sync/cancel
   */
  @Post('sync/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelSync(@WorkspaceId() workspaceId: string) {
    const result = this.communicationService.cancelSync(workspaceId);
    return { data: result };
  }

  // ==================== ORPHAN CLEANUP ====================

  /**
   * Find orphaned tenants (no integrations, no phone numbers).
   * GET /api/tenants/orphans
   */
  @Get('orphans')
  async findOrphanedTenants(@WorkspaceId() workspaceId: string) {
    const orphans = await this.tenantsService.findOrphanedTenants(workspaceId);
    return { data: orphans };
  }

  /**
   * Delete orphaned tenants.
   * DELETE /api/tenants/orphans
   */
  @Delete('orphans')
  @HttpCode(HttpStatus.OK)
  async deleteOrphanedTenants(
    @WorkspaceId() workspaceId: string,
    @Body() body?: { tenantIds?: string[] },
  ) {
    const result = await this.tenantsService.deleteOrphanedTenants(workspaceId, body?.tenantIds);
    return { data: result };
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
   * Re-configure Twilio webhook URLs for all phone numbers in a tenant.
   * Call after re-provisioning a tenant to fix stale webhook domains (404 on inbound calls).
   * POST /api/tenants/:id/phone-numbers/refresh-webhooks
   */
  @Post(':id/phone-numbers/refresh-webhooks')
  @HttpCode(HttpStatus.OK)
  async refreshPhoneWebhooks(
    @WorkspaceId() workspaceId: string,
    @Request() req: any,
    @Param('id') tenantId: string,
  ) {
    if (req.apiKeyScope === 'tenant') {
      throw new ForbiddenException('Tenant keys cannot refresh phone webhooks');
    }
    const result = await this.provisioningService.refreshPhoneWebhooks(workspaceId, tenantId);
    return { data: result };
  }

  /**
   * Re-home a phone allocation to a different tenant within the workspace.
   * Used by LeadBridge when converting a pool number to dedicated so the allocation
   * is moved from the platform tenant to the real tenant.
   * Platform key only.
   * PATCH /api/tenants/phone-numbers/:phoneNumber/reallocate
   */
  @Patch('phone-numbers/:phoneNumber/reallocate')
  @HttpCode(HttpStatus.OK)
  async reallocatePhoneNumber(
    @WorkspaceId() workspaceId: string,
    @Request() req: any,
    @Param('phoneNumber') phoneNumber: string,
    @Body() dto: { tenantId: string },
  ) {
    if (req.apiKeyScope === 'tenant') {
      throw new ForbiddenException('Tenant keys cannot reallocate phone numbers');
    }
    const allocation = await this.provisioningService.reallocatePhoneNumber(
      workspaceId,
      phoneNumber,
      dto.tenantId,
    );
    return { data: allocation };
  }

  /**
   * Set the call-forwarding number on a phone allocation's metadata.
   * Searches across all tenants in the workspace — used by LeadBridge after re-provisioning
   * so the allocation stays in sync regardless of which Sigcore tenant "owns" the number.
   * PATCH /api/tenants/phone-numbers/:phoneNumber/call-forwarding
   */
  @Patch('phone-numbers/:phoneNumber/call-forwarding')
  @HttpCode(HttpStatus.OK)
  async setPhoneCallForwarding(
    @WorkspaceId() workspaceId: string,
    @Request() req: any,
    @Param('phoneNumber') phoneNumber: string,
    @Body() dto: { callForwardingNumber: string | null },
  ) {
    if (req.apiKeyScope === 'tenant') {
      throw new ForbiddenException('Tenant keys cannot set phone call-forwarding');
    }
    const result = await this.provisioningService.setPhoneCallForwarding(
      workspaceId,
      phoneNumber,
      dto.callForwardingNumber ?? null,
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
