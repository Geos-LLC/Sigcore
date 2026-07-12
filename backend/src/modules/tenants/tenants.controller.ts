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
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { TenantsService, CreateTenantDto, AllocatePhoneNumberDto, ConnectTenantIntegrationDto } from './tenants.service';
import { PhoneNumberProvisioningService } from './phone-number-provisioning.service';
import { SetVoiceWebhookDto } from './dto/voice-webhook.dto';
import { validateVoiceInboundUrl } from './voice-webhook-url.validator';
import { ConfigService } from '@nestjs/config';
import { ApiKeysService } from '../api/api-keys.service';
import { CommunicationService } from '../communication/communication.service';
import { SigcoreAuthGuard } from '../auth/sigcore-auth.guard';
import { WorkspaceId, TenantId } from '../auth/decorators/workspace-id.decorator';
import { RequiresWorkspaceScope } from '../auth/decorators/require-workspace-scope.decorator';
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
/**
 * Enforce per-tenant scope on `/:id/*` routes. Tenant-scoped callers may only
 * touch their own tenant record. Workspace-scoped callers pass through.
 */
function assertCanAccessTenant(callerTenantId: string | null, targetTenantId: string): void {
  if (callerTenantId && callerTenantId !== targetTenantId) {
    throw new ForbiddenException(
      'Tenant-scoped API keys can only access their own tenant record.',
    );
  }
}

@Controller('tenants')
@UseGuards(SigcoreAuthGuard)
export class TenantsController {
  constructor(
    private readonly tenantsService: TenantsService,
    private readonly provisioningService: PhoneNumberProvisioningService,
    private readonly apiKeysService: ApiKeysService,
    private readonly communicationService: CommunicationService,
  ) {}

  private assertCanAccessTenant = assertCanAccessTenant;

  // ==================== TENANT MANAGEMENT ====================

  /**
   * Create a new tenant
   * POST /api/tenants
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequiresWorkspaceScope()
  async createTenant(
    @WorkspaceId() workspaceId: string,
    @Body() dto: CreateTenantDto,
  ) {
    const tenant = await this.tenantsService.createTenant(workspaceId, dto);
    return { data: tenant };
  }

  /**
   * Provision a tenant + tenant API key in one call (idempotent by externalTenantId).
   *
   * PR10: hardened idempotency. Repeated calls with the same externalTenantId
   * return the same tenant id. Anchor names/external_ids (LeadBridge,
   * HireFunnel, ServiceFlow, Callio) are rejected — they're platform handles,
   * not customer tenants. Inactive tenants are not reused unless the caller
   * passes `allowInactive: true`. API keys: by default, mint a new key on
   * every provision (back-compat with existing LB callers). Pass
   * `reuseActiveKey: true` to receive an existing-key summary instead.
   *
   * POST /api/tenants/provision
   */
  @Post('provision')
  @HttpCode(HttpStatus.OK)
  @RequiresWorkspaceScope()
  async provisionTenant(
    @WorkspaceId() workspaceId: string,
    @Body()
    dto: {
      externalTenantId: string;
      displayName?: string;
      allowInactive?: boolean;
      /** When true, skip minting a new key if an active key already exists. */
      reuseActiveKey?: boolean;
    },
  ) {
    const helpers = await import('./idempotent-provisioning.helpers');
    const { tenant, reused } =
      await this.tenantsService.findOrCreateTenantByExternalId(workspaceId, {
        externalTenantId: dto.externalTenantId,
        displayName: dto.displayName,
        allowInactive: dto.allowInactive,
      });

    // API key handling — see locked decisions in idempotent-provisioning.helpers.ts.
    let issuedKey: string | undefined;
    let apiKeySummary: import('./idempotent-provisioning.helpers').ApiKeySummary | undefined;
    let apiKeyReused = false;

    if (dto.reuseActiveKey) {
      const active = await this.apiKeysService.getActiveTenantApiKey(workspaceId, tenant.id);
      if (active) {
        apiKeySummary = helpers.summarizeApiKey({
          id: active.id,
          name: active.name,
          key: active.key,
          active: active.active,
          createdAt: active.createdAt,
          lastUsedAt: active.lastUsedAt ?? null,
        });
        apiKeyReused = true;
      } else {
        const result = await this.apiKeysService.createTenantApiKey(
          workspaceId,
          tenant.id,
          'LeadBridge Key',
        );
        issuedKey = result.key;
      }
    } else {
      // Back-compat default: always mint a fresh key. Existing callers (LB)
      // depend on `apiKey` being present in the response.
      const result = await this.apiKeysService.createTenantApiKey(
        workspaceId,
        tenant.id,
        'LeadBridge Key',
      );
      issuedKey = result.key;
    }

    return {
      data: {
        // Back-compat fields (unchanged shape) ----------------------------
        tenantId: tenant.id,
        externalTenantId: tenant.externalId,
        apiKey: issuedKey,
        // `isNew` is the legacy name for "tenant was created on this call".
        isNew: !reused,
        // PR10 fields -----------------------------------------------------
        reused: { tenant: reused, apiKey: apiKeyReused },
        apiKeySummary,
      },
    };
  }

  /**
   * Copy integrations from another tenant (used during re-provisioning shared tenants).
   * POST /api/tenants/:tenantId/copy-integrations
   */
  @Post(':tenantId/copy-integrations')
  @HttpCode(HttpStatus.OK)
  @RequiresWorkspaceScope()
  async copyIntegrations(
    @WorkspaceId() workspaceId: string,
    @Param('tenantId') tenantId: string,
    @Body() dto: { fromTenantId: string },
  ) {
    const result = await this.tenantsService.copyTenantIntegrations(workspaceId, dto.fromTenantId, tenantId);
    return { data: result };
  }

  /**
   * List tenants visible to the caller.
   *
   * Workspace-scoped: full list, admin listing (unchanged).
   * Tenant-scoped: returns `[self]` — the caller's own tenant record only.
   * Fixes the Callio-shared-workspace leak where every tenant key in the master
   * workspace saw the union of every product's provisioned tenants.
   *
   * GET /api/tenants
   */
  @Get()
  async getTenants(
    @WorkspaceId() workspaceId: string,
    @TenantId() callerTenantId: string | null,
  ) {
    const tenants = await this.tenantsService.getTenants(workspaceId, { callerTenantId });
    return { data: tenants };
  }

  // ==================== SYNC MONITOR ====================

  /**
   * Get sync status for the workspace.
   * GET /api/tenants/sync/status
   */
  @Get('sync/status')
  @RequiresWorkspaceScope()
  async getSyncStatus(@WorkspaceId() workspaceId: string) {
    const status = this.communicationService.getSyncStatus(workspaceId);
    return { data: status };
  }

  /**
   * Get tenants (with integrations) for the sync monitor.
   * Workspace-scoped: full workspace overview.
   * Tenant-scoped: single-row overview for the caller's own tenant.
   * GET /api/tenants/sync/overview
   */
  @Get('sync/overview')
  async getSyncOverview(
    @WorkspaceId() workspaceId: string,
    @TenantId() callerTenantId: string | null,
  ) {
    const tenants = await this.tenantsService.getTenants(workspaceId, { callerTenantId });
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
  @RequiresWorkspaceScope()
  async cancelSync(@WorkspaceId() workspaceId: string) {
    const result = this.communicationService.cancelSync(workspaceId);
    return { data: result };
  }

  // ==================== ORPHAN CLEANUP ====================

  /**
   * Find orphaned tenants (no integrations, no phone numbers).
   * Workspace-scoped: full workspace scan.
   * Tenant-scoped: `[]` — orphan enumeration is inherently cross-tenant, but a
   * hard 403 would break naive UIs; an empty list matches the "you see nothing
   * you don't own" model without needing error handling.
   * GET /api/tenants/orphans
   */
  @Get('orphans')
  async findOrphanedTenants(
    @WorkspaceId() workspaceId: string,
    @TenantId() callerTenantId: string | null,
  ) {
    if (callerTenantId) {
      return { data: [] };
    }
    const orphans = await this.tenantsService.findOrphanedTenants(workspaceId);
    return { data: orphans };
  }

  /**
   * Delete orphaned tenants.
   * DELETE /api/tenants/orphans
   */
  @Delete('orphans')
  @HttpCode(HttpStatus.OK)
  @RequiresWorkspaceScope()
  async deleteOrphanedTenants(
    @WorkspaceId() workspaceId: string,
    @Body() body?: { tenantIds?: string[] },
  ) {
    const result = await this.tenantsService.deleteOrphanedTenants(workspaceId, body?.tenantIds);
    return { data: result };
  }

  /**
   * Get a specific tenant. Tenant-scoped callers may only read their own.
   * GET /api/tenants/:id
   */
  @Get(':id')
  async getTenant(
    @WorkspaceId() workspaceId: string,
    @TenantId() callerTenantId: string | null,
    @Param('id') tenantId: string,
  ) {
    const tenant = await this.tenantsService.getTenant(workspaceId, tenantId, callerTenantId);
    return { data: tenant };
  }

  /**
   * Update a tenant. Tenant-scoped callers may only update their own.
   * PUT /api/tenants/:id
   */
  @Put(':id')
  async updateTenant(
    @WorkspaceId() workspaceId: string,
    @TenantId() callerTenantId: string | null,
    @Param('id') tenantId: string,
    @Body() dto: { name?: string; status?: TenantStatus; metadata?: Record<string, unknown>; webhookUrl?: string; webhookSecret?: string },
  ) {
    this.assertCanAccessTenant(callerTenantId, tenantId);
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
    @TenantId() callerTenantId: string | null,
    @Param('id') tenantId: string,
    @Body() dto: { webhookUrl?: string; webhookSecret?: string },
  ) {
    this.assertCanAccessTenant(callerTenantId, tenantId);
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
    @TenantId() callerTenantId: string | null,
    @Param('id') tenantId: string,
  ) {
    const tenant = await this.tenantsService.getTenant(workspaceId, tenantId, callerTenantId);
    return {
      data: {
        webhookUrl: tenant.webhookUrl,
        webhookConfigured: !!tenant.webhookUrl,
        hasSecret: !!tenant.webhookSecret,
      },
    };
  }

  /**
   * Delete a tenant. Workspace-scoped callers only — a tenant deleting itself
   * would leave provisioning callers holding a dead reference.
   * DELETE /api/tenants/:id
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequiresWorkspaceScope()
  async deleteTenant(
    @WorkspaceId() workspaceId: string,
    @Param('id') tenantId: string,
  ) {
    await this.tenantsService.deleteTenant(workspaceId, tenantId);
  }

  // ==================== PHONE NUMBER MANAGEMENT ====================

  /**
   * Get all available phone numbers across every integration in the workspace.
   * Workspace-admin only — the response includes `allocatedTo` for cross-tenant
   * allocations and cannot be safely shown to a tenant caller.
   * GET /api/tenants/phone-numbers/available
   */
  @Get('phone-numbers/available')
  @RequiresWorkspaceScope()
  async getAvailablePhoneNumbers(@WorkspaceId() workspaceId: string) {
    const phoneNumbers = await this.tenantsService.getAvailablePhoneNumbers(workspaceId);
    return { data: phoneNumbers };
  }

  /**
   * Allocate a phone number to a tenant (admin action).
   * POST /api/tenants/:id/phone-numbers
   */
  @Post(':id/phone-numbers')
  @HttpCode(HttpStatus.CREATED)
  @RequiresWorkspaceScope()
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
   * Get phone numbers allocated to a tenant.
   * Tenant-scoped callers may read their own numbers.
   * GET /api/tenants/:id/phone-numbers
   */
  @Get(':id/phone-numbers')
  async getTenantPhoneNumbers(
    @WorkspaceId() workspaceId: string,
    @TenantId() callerTenantId: string | null,
    @Param('id') tenantId: string,
  ) {
    this.assertCanAccessTenant(callerTenantId, tenantId);
    const phoneNumbers = await this.tenantsService.getTenantPhoneNumbers(workspaceId, tenantId);
    return { data: phoneNumbers };
  }

  /**
   * Deallocate a phone number from a tenant (admin action).
   * DELETE /api/tenants/:id/phone-numbers/:allocationId
   */
  @Delete(':id/phone-numbers/:allocationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequiresWorkspaceScope()
  async deallocatePhoneNumber(
    @WorkspaceId() workspaceId: string,
    @Param('id') tenantId: string,
    @Param('allocationId') allocationId: string,
  ) {
    await this.tenantsService.deallocatePhoneNumber(workspaceId, allocationId);
  }

  /**
   * Set a phone number as default for a tenant.
   * Tenant-scoped callers may set defaults on their own tenant.
   * POST /api/tenants/:id/phone-numbers/:allocationId/default
   */
  @Post(':id/phone-numbers/:allocationId/default')
  @HttpCode(HttpStatus.OK)
  async setDefaultPhoneNumber(
    @WorkspaceId() workspaceId: string,
    @TenantId() callerTenantId: string | null,
    @Param('id') tenantId: string,
    @Param('allocationId') allocationId: string,
  ) {
    this.assertCanAccessTenant(callerTenantId, tenantId);
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
  @RequiresWorkspaceScope()
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
   * Purchase a phone number for a tenant (admin action).
   * Tenant self-service purchase lives at POST /api/v1/tenants/:tenantId/phone-numbers/purchase.
   * POST /api/tenants/:id/phone-numbers/purchase
   */
  @Post(':id/phone-numbers/purchase')
  @HttpCode(HttpStatus.CREATED)
  @RequiresWorkspaceScope()
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
      dto.channel,
    );
    return { data: result };
  }

  /**
   * Release a provisioned phone number (admin action).
   * Tenant self-service release lives at POST /api/v1/tenants/:tenantId/phone-numbers/:allocationId/release.
   * POST /api/tenants/:id/phone-numbers/:allocationId/release
   */
  @Post(':id/phone-numbers/:allocationId/release')
  @HttpCode(HttpStatus.OK)
  @RequiresWorkspaceScope()
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
  @RequiresWorkspaceScope()
  async refreshPhoneWebhooks(
    @WorkspaceId() workspaceId: string,
    @Param('id') tenantId: string,
  ) {
    const result = await this.provisioningService.refreshPhoneWebhooks(workspaceId, tenantId);
    return { data: result };
  }

  /**
   * Set the SMS webhook URL on every Twilio number allocated to a tenant.
   * Unlike refresh-webhooks (which writes the BYO workspace-scoped URL), this
   * endpoint accepts an explicit URL and is used by LeadBridge to migrate to
   * the tenant-scoped /webhooks/twilio/sms/lb/:tenantId route (Issue #114).
   * Voice webhook configuration is NOT modified.
   *
   * Platform key only. Idempotent.
   * POST /api/tenants/:id/phone-numbers/set-webhook-url
   */
  @Post(':id/phone-numbers/set-webhook-url')
  @HttpCode(HttpStatus.OK)
  @RequiresWorkspaceScope()
  async setPhoneSmsWebhookUrl(
    @WorkspaceId() workspaceId: string,
    @Param('id') tenantId: string,
    @Body() dto: { smsUrl: string; smsMethod?: string },
  ) {
    if (!dto?.smsUrl || typeof dto.smsUrl !== 'string') {
      throw new BadRequestException('smsUrl is required');
    }
    const method = dto.smsMethod ?? 'POST';
    if (method !== 'POST' && method !== 'GET') {
      throw new BadRequestException('smsMethod must be POST or GET');
    }
    const result = await this.provisioningService.setSmsWebhookUrl(
      workspaceId,
      tenantId,
      dto.smsUrl,
      method,
    );
    return { success: result.success, results: result.results };
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
  @RequiresWorkspaceScope()
  async reallocatePhoneNumber(
    @WorkspaceId() workspaceId: string,
    @Param('phoneNumber') phoneNumber: string,
    @Body() dto: { tenantId: string },
  ) {
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
  @RequiresWorkspaceScope()
  async setPhoneCallForwarding(
    @WorkspaceId() workspaceId: string,
    @Param('phoneNumber') phoneNumber: string,
    @Body() dto: { callForwardingNumber: string | null },
  ) {
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
    @TenantId() callerTenantId: string | null,
    @Param('id') tenantId: string,
    @Param('allocationId') allocationId: string,
  ) {
    this.assertCanAccessTenant(callerTenantId, tenantId);
    const result = await this.provisioningService.retryA2PAttachment(workspaceId, allocationId);
    return { data: result };
  }

  /**
   * Get order history for a tenant.
   * Tenant-scoped callers may read their own tenant's history.
   * GET /api/tenants/:id/phone-numbers/orders
   */
  @Get(':id/phone-numbers/orders')
  async getTenantOrderHistory(
    @WorkspaceId() workspaceId: string,
    @TenantId() callerTenantId: string | null,
    @Param('id') tenantId: string,
  ) {
    this.assertCanAccessTenant(callerTenantId, tenantId);
    const orders = await this.provisioningService.getTenantOrderHistory(workspaceId, tenantId);
    return { data: orders };
  }

  /**
   * Get all phone number orders for the workspace.
   * Workspace-scoped: all orders. Tenant-scoped: caller's tenant only.
   * GET /api/tenants/phone-numbers/orders
   */
  @Get('phone-numbers/orders')
  async getWorkspaceOrderHistory(
    @WorkspaceId() workspaceId: string,
    @TenantId() callerTenantId: string | null,
  ) {
    const orders = await this.provisioningService.getWorkspaceOrderHistory(workspaceId, callerTenantId);
    return { data: orders };
  }

  /**
   * Get pricing configuration.
   * Workspace-level config; the same shape is exposed to tenants at
   * GET /api/v1/tenants/phone-numbers/pricing so tenants can display prices.
   * GET /api/tenants/pricing
   */
  @Get('pricing')
  async getPricingConfig(@WorkspaceId() workspaceId: string) {
    const config = await this.provisioningService.getPricingConfig(workspaceId);
    return { data: config };
  }

  /**
   * Update pricing configuration (workspace-admin only).
   * PUT /api/tenants/pricing
   */
  @Put('pricing')
  @RequiresWorkspaceScope()
  async updatePricingConfig(
    @WorkspaceId() workspaceId: string,
    @Body() dto: UpdatePricingConfigDto,
  ) {
    const config = await this.provisioningService.updatePricingConfig(workspaceId, dto);
    return { data: config };
  }

  // ==================== TENANT API KEYS (Admin) ====================

  /**
   * Create an API key for a tenant (workspace-admin only).
   * Minting keys is a cross-tenant mutation that must not be reachable from a
   * tenant-scoped caller — otherwise Callio's tenant key could mint a key for
   * an LB customer's tenant in the same workspace.
   * POST /api/tenants/:id/api-keys
   */
  @Post(':id/api-keys')
  @HttpCode(HttpStatus.CREATED)
  @RequiresWorkspaceScope()
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
   * List API keys for a tenant (workspace-admin only).
   * Returns full key secrets and last-used metadata — must not be accessible
   * to tenant-scoped callers.
   * GET /api/tenants/:id/api-keys
   */
  @Get(':id/api-keys')
  @RequiresWorkspaceScope()
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
   * Revoke a tenant API key (workspace-admin only).
   * DELETE /api/tenants/:id/api-keys/:keyId
   */
  @Delete(':id/api-keys/:keyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequiresWorkspaceScope()
  async deleteTenantApiKey(
    @WorkspaceId() workspaceId: string,
    @Param('id') tenantId: string,
    @Param('keyId') keyId: string,
  ) {
    await this.apiKeysService.deleteTenantApiKey(workspaceId, tenantId, keyId);
  }

  // ==================== TENANT INTEGRATIONS (Admin) ====================

  /**
   * Connect a provider integration for a tenant (workspace-admin only).
   * Tenant self-service equivalent: POST /api/v1/tenants/:tenantId/integrations.
   * Blocking tenant-scoped callers here prevents cross-tenant integration
   * mutation (Callio tenant key touching an LB tenant's Twilio/OpenPhone).
   * POST /api/tenants/:id/integrations
   */
  @Post(':id/integrations')
  @HttpCode(HttpStatus.CREATED)
  @RequiresWorkspaceScope()
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
   * Get all integrations for a tenant (workspace-admin only).
   * Tenant self-service equivalent: GET /api/v1/tenants/:tenantId/integrations.
   * GET /api/tenants/:id/integrations
   */
  @Get(':id/integrations')
  @RequiresWorkspaceScope()
  async getTenantIntegrations(
    @WorkspaceId() workspaceId: string,
    @Param('id') tenantId: string,
  ) {
    const integrations = await this.tenantsService.getTenantIntegrations(workspaceId, tenantId);
    return { data: integrations };
  }

  /**
   * Update a tenant integration (workspace-admin only).
   * PUT /api/tenants/:id/integrations/:integrationId
   */
  @Put(':id/integrations/:integrationId')
  @RequiresWorkspaceScope()
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
   * Delete a tenant integration (workspace-admin only).
   * DELETE /api/tenants/:id/integrations/:integrationId
   */
  @Delete(':id/integrations/:integrationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequiresWorkspaceScope()
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
    private readonly configService: ConfigService,
  ) {}

  private assertCanAccessTenant = assertCanAccessTenant;

  /**
   * Get tenant by external ID.
   * Tenant-scoped callers may only look up their own tenant; a mismatch
   * returns null rather than exposing another tenant's record.
   * GET /api/v1/tenants/by-external-id?externalId=xxx
   */
  @Get('by-external-id')
  async getTenantByExternalId(
    @WorkspaceId() workspaceId: string,
    @TenantId() callerTenantId: string | null,
    @Query('externalId') externalId: string,
  ) {
    const tenant = await this.tenantsService.getTenantByExternalId(workspaceId, externalId);
    if (tenant && callerTenantId && tenant.id !== callerTenantId) {
      return { data: null };
    }
    return { data: tenant };
  }

  /**
   * Get phone numbers for a tenant by external ID.
   * Tenant-scoped callers may only look up their own.
   * GET /api/v1/tenants/by-external-id/phone-numbers?externalId=xxx
   */
  @Get('by-external-id/phone-numbers')
  async getTenantPhoneNumbersByExternalId(
    @WorkspaceId() workspaceId: string,
    @TenantId() callerTenantId: string | null,
    @Query('externalId') externalId: string,
  ) {
    const tenant = await this.tenantsService.getTenantByExternalId(workspaceId, externalId);
    if (!tenant) {
      return { data: [] };
    }
    if (callerTenantId && tenant.id !== callerTenantId) {
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
    @TenantId() callerTenantId: string | null,
    @Param('tenantId') tenantId: string,
  ) {
    this.assertCanAccessTenant(callerTenantId, tenantId);
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
    @TenantId() callerTenantId: string | null,
    @Param('tenantId') tenantId: string,
    @Body() dto: ConnectTenantIntegrationDto,
  ) {
    this.assertCanAccessTenant(callerTenantId, tenantId);
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
    @TenantId() callerTenantId: string | null,
    @Param('tenantId') tenantId: string,
  ) {
    this.assertCanAccessTenant(callerTenantId, tenantId);
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
    @TenantId() callerTenantId: string | null,
    @Param('tenantId') tenantId: string,
    @Param('integrationId') integrationId: string,
  ) {
    this.assertCanAccessTenant(callerTenantId, tenantId);
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
    @TenantId() callerTenantId: string | null,
    @Param('tenantId') tenantId: string,
    @Body() dto: PurchasePhoneNumberDto,
  ) {
    this.assertCanAccessTenant(callerTenantId, tenantId);
    const result = await this.provisioningService.tenantPurchaseNumber(
      workspaceId,
      tenantId,
      dto.phoneNumber,
      dto.friendlyName,
      dto.channel,
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
    @TenantId() callerTenantId: string | null,
    @Param('tenantId') tenantId: string,
    @Param('allocationId') allocationId: string,
  ) {
    this.assertCanAccessTenant(callerTenantId, tenantId);
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
    @TenantId() callerTenantId: string | null,
    @Param('tenantId') tenantId: string,
  ) {
    this.assertCanAccessTenant(callerTenantId, tenantId);
    const orders = await this.provisioningService.getTenantOrderHistory(workspaceId, tenantId);
    return { data: orders };
  }

  /**
   * Update pricing configuration (workspace-admin only).
   * Historically mounted under /v1/ for legacy reasons; keep the URL but
   * enforce workspace scope since it's a config mutation.
   * PUT /api/v1/tenants/phone-numbers/pricing
   */
  @Put('phone-numbers/pricing')
  @RequiresWorkspaceScope()
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
    @TenantId() callerTenantId: string | null,
    @Param('tenantId') tenantId: string,
    @Body() dto: { webhookUrl?: string; webhookSecret?: string },
  ) {
    this.assertCanAccessTenant(callerTenantId, tenantId);
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
    @TenantId() callerTenantId: string | null,
    @Param('tenantId') tenantId: string,
  ) {
    const tenant = await this.tenantsService.getTenant(workspaceId, tenantId, callerTenantId);
    return {
      data: {
        webhookUrl: tenant.webhookUrl,
        webhookConfigured: !!tenant.webhookUrl,
        hasSecret: !!tenant.webhookSecret,
      },
    };
  }

  // ==================== TENANT VOICE INBOUND ENDPOINT (Wave-2 PR 2) ====================
  //
  // Manage the tenant-configured inbound voice endpoint. PR 2 is
  // configuration-only — nothing consumes `voice_inbound_url` at runtime until
  // PR 3 wires it into the inbound Twilio voice router behind the
  // SIGCORE_VOICE_INBOUND_FORWARD_ENABLED flag.

  /**
   * Get the tenant's configured inbound voice endpoint.
   * GET /api/v1/tenants/:tenantId/voice-webhook
   *
   * Auth: SigcoreAuthGuard + assertCanAccessTenant — same model as the
   * outbound-events webhook read (:tenantId/webhook).
   */
  @Get(':tenantId/voice-webhook')
  async getVoiceWebhook(
    @WorkspaceId() workspaceId: string,
    @TenantId() callerTenantId: string | null,
    @Param('tenantId') tenantId: string,
  ) {
    this.assertCanAccessTenant(callerTenantId, tenantId);
    const config = await this.tenantsService.getVoiceInboundConfig(
      workspaceId,
      tenantId,
      callerTenantId,
    );
    return { data: config };
  }

  /**
   * Set or clear the tenant's inbound voice endpoint URL.
   * PUT /api/v1/tenants/:tenantId/voice-webhook
   *
   * Body:
   *   { voiceInboundUrl: "https://..." }  → set
   *   { voiceInboundUrl: null }          → clear
   *   {}                                  → clear (omitted field)
   *
   * URL validation lives in `validateVoiceInboundUrl`:
   *   - accepts https:// (any host, any path)
   *   - accepts http:// to localhost / 127.0.0.1 only when NODE_ENV is
   *     'development' or 'test'
   *   - rejects ftp, ws, wss, file, javascript, data, gopher, etc.
   *   - rejects empty strings (use null to clear)
   *   - rejects malformed URLs
   *
   * The service rejects INACTIVE or SUSPENDED tenants (403).
   */
  @Put(':tenantId/voice-webhook')
  async setVoiceWebhook(
    @WorkspaceId() workspaceId: string,
    @TenantId() callerTenantId: string | null,
    @Param('tenantId') tenantId: string,
    @Body() dto: SetVoiceWebhookDto,
  ) {
    this.assertCanAccessTenant(callerTenantId, tenantId);
    let toStore: string | null;
    if (dto?.voiceInboundUrl === undefined || dto?.voiceInboundUrl === null) {
      toStore = null;
    } else {
      const nodeEnv = (
        this.configService.get<string>('NODE_ENV') ?? 'production'
      ).toLowerCase();
      const allowInsecureLocalhost =
        nodeEnv === 'development' || nodeEnv === 'test';
      toStore = validateVoiceInboundUrl(dto.voiceInboundUrl, {
        allowInsecureLocalhost,
      });
    }
    const tenant = await this.tenantsService.setVoiceInboundUrl(
      workspaceId,
      tenantId,
      callerTenantId,
      toStore,
    );
    return {
      data: {
        voiceInboundUrl: tenant.voiceInboundUrl ?? null,
        configured: !!tenant.voiceInboundUrl,
      },
    };
  }
}
