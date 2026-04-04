import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { IntegrationsService } from './integrations.service';
import { CommunicationService } from '../communication/communication.service';
import { SetupIntegrationDto, SetupTwilioIntegrationDto, UpdateTwilioPhoneNumberDto } from './dto';
import { SigcoreAuthGuard } from '../auth/sigcore-auth.guard';
import { WorkspaceId, TenantId } from '../auth/decorators/workspace-id.decorator';
import { ProviderType } from '../../database/entities/communication-integration.entity';

export interface SyncOptions {
  limit?: number;
  since?: string; // ISO date string - start of date range
  until?: string; // ISO date string - end of date range
  syncMessages?: boolean;
  forceRefresh?: boolean;
  phoneNumberId?: string; // If provided, only sync conversations from this phone line
  onlySavedContacts?: boolean; // If true, only sync conversations where contact has a name
  provider?: ProviderType; // If provided, sync from this provider (defaults to first active integration)
}

export interface QuickSyncOptions {
  conversationIds?: string[]; // If provided, only sync these specific conversations
}

@Controller('integrations')
@UseGuards(SigcoreAuthGuard)
export class IntegrationsController {
  constructor(
    private readonly integrationsService: IntegrationsService,
    private readonly communicationService: CommunicationService,
  ) {}

  // ==================== GENERAL INTEGRATION ENDPOINTS ====================

  @Get()
  async getIntegration(
    @WorkspaceId() workspaceId: string,
    @Query('provider') provider?: ProviderType,
  ) {
    const integration = await this.integrationsService.getIntegration(workspaceId, provider);
    return { data: integration };
  }

  @Get('all')
  async getIntegrations(@WorkspaceId() workspaceId: string) {
    const integrations = await this.integrationsService.getIntegrations(workspaceId);
    return { data: integrations, workspaceId };
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  async setupIntegration(
    @WorkspaceId() workspaceId: string,
    @Body() dto: SetupIntegrationDto,
  ) {
    const integration = await this.integrationsService.setupIntegration(
      workspaceId,
      dto,
    );
    return { data: integration };
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  async deleteIntegration(
    @WorkspaceId() workspaceId: string,
    @Query('provider') provider?: ProviderType,
  ) {
    const result = await this.integrationsService.deleteIntegration(workspaceId, provider);
    return { data: result };
  }

  // ==================== OPENPHONE-SPECIFIC ENDPOINTS ====================

  /**
   * Connect OpenPhone integration.
   * When called with a tenant API key, stores credentials in TenantIntegration (tenant-scoped).
   * When called with a workspace API key, stores in CommunicationIntegration (workspace-scoped).
   * POST /integrations/openphone/connect
   */
  @Post('openphone/connect')
  @HttpCode(HttpStatus.OK)
  async connectOpenPhone(
    @WorkspaceId() workspaceId: string,
    @TenantId() tenantId: string | null,
    @Body() dto: { apiKey: string },
  ) {
    if (tenantId) {
      const integration = await this.integrationsService.connectOpenPhoneForTenant(workspaceId, tenantId, dto.apiKey);
      return { data: integration };
    }
    const integration = await this.integrationsService.setupIntegration(workspaceId, {
      provider: ProviderType.OPENPHONE,
      apiKey: dto.apiKey,
    });
    return { data: integration };
  }

  /**
   * Get OpenPhone phone numbers.
   * When called with a tenant API key, returns numbers from TenantIntegration.
   * GET /integrations/openphone/numbers
   */
  @Get('openphone/numbers')
  async getOpenPhoneNumbers(
    @WorkspaceId() workspaceId: string,
    @TenantId() tenantId: string | null,
  ) {
    if (tenantId) {
      const phoneNumbers = await this.integrationsService.getOpenPhoneNumbersForTenant(workspaceId, tenantId);
      return { data: phoneNumbers };
    }
    const phoneNumbers = await this.integrationsService.getOpenPhoneNumbers(workspaceId);
    return { data: phoneNumbers };
  }

  /**
   * Get recent conversations from OpenPhone (live from API, not stored in DB)
   * GET /integrations/openphone/conversations?days=1
   */
  @Get('openphone/conversations')
  async getOpenPhoneConversations(
    @WorkspaceId() workspaceId: string,
    @Query('days') days?: string,
  ) {
    const daysNum = days ? Math.min(Math.max(parseInt(days, 10) || 1, 1), 5) : 1;
    const conversations = await this.integrationsService.getOpenPhoneConversations(workspaceId, daysNum);
    return { data: conversations };
  }

  /**
   * Disconnect OpenPhone integration.
   * When called with a tenant API key, removes the TenantIntegration record.
   * DELETE /integrations/openphone/disconnect
   */
  @Delete('openphone/disconnect')
  @HttpCode(HttpStatus.OK)
  async disconnectOpenPhone(
    @WorkspaceId() workspaceId: string,
    @TenantId() tenantId: string | null,
  ) {
    if (tenantId) {
      const result = await this.integrationsService.disconnectOpenPhoneForTenant(workspaceId, tenantId);
      return { data: result };
    }
    const result = await this.integrationsService.deleteIntegration(workspaceId, ProviderType.OPENPHONE);
    return { data: result };
  }

  // ==================== TWILIO-SPECIFIC ENDPOINTS ====================

  @Post('twilio')
  @HttpCode(HttpStatus.OK)
  async setupTwilioIntegration(
    @WorkspaceId() workspaceId: string,
    @Body() dto: SetupTwilioIntegrationDto,
  ) {
    const integration = await this.integrationsService.setupTwilioIntegration(
      workspaceId,
      dto,
    );
    return { data: integration };
  }

  @Get('twilio/phone-numbers')
  async getTwilioPhoneNumbers(@WorkspaceId() workspaceId: string) {
    const phoneNumbers = await this.integrationsService.getTwilioPhoneNumbers(workspaceId);
    return { data: phoneNumbers };
  }

  @Patch('twilio/phone-number')
  @HttpCode(HttpStatus.OK)
  async updateTwilioPhoneNumber(
    @WorkspaceId() workspaceId: string,
    @Body() dto: UpdateTwilioPhoneNumberDto,
  ) {
    const integration = await this.integrationsService.updateTwilioPhoneNumber(
      workspaceId,
      dto,
    );
    return { data: integration };
  }

  @Delete('twilio')
  @HttpCode(HttpStatus.OK)
  async deleteTwilioIntegration(@WorkspaceId() workspaceId: string) {
    const result = await this.integrationsService.deleteIntegration(workspaceId, ProviderType.TWILIO);
    return { data: result };
  }

  // ==================== SYNC ENDPOINTS ====================

  @Post('sync')
  @HttpCode(HttpStatus.ACCEPTED)
  async syncConversations(
    @WorkspaceId() workspaceId: string,
    @TenantId() tenantId: string | null,
    @Body() options?: SyncOptions,
  ) {
    // Log the provider being requested
    console.log(`[SYNC REQUEST] Provider: ${options?.provider || 'undefined (will use first active)'}, tenantId: ${tenantId || 'none'}, Options:`, JSON.stringify(options));

    // Start sync in background - don't await
    // This prevents HTTP timeout for long-running syncs
    this.communicationService.syncConversations(workspaceId, {
      limit: options?.limit,
      since: options?.since ? new Date(options.since) : undefined,
      until: options?.until ? new Date(options.until) : undefined,
      syncMessages: options?.syncMessages ?? true,
      forceRefresh: options?.forceRefresh ?? false,
      phoneNumberId: options?.phoneNumberId,
      onlySavedContacts: options?.onlySavedContacts ?? true,
      provider: options?.provider,
      tenantId,
    }).catch(err => {
      // Log error but don't throw - sync status will reflect the error
      console.error('Background sync error:', err);
    });

    // Return immediately with 202 Accepted
    return { data: { started: true, message: 'Sync started in background. Poll /sync/status for progress.' } };
  }

  @Post('sync/quick')
  @HttpCode(HttpStatus.OK)
  async quickSyncConversations(
    @WorkspaceId() workspaceId: string,
    @Body() options?: QuickSyncOptions,
  ) {
    const result = await this.communicationService.quickSyncConversations(
      workspaceId,
      options?.conversationIds,
    );
    return { data: result };
  }

  @Post('sync/contacts')
  @HttpCode(HttpStatus.OK)
  async syncContacts(
    @WorkspaceId() workspaceId: string,
    @Body() options?: { limit?: number },
  ) {
    const result = await this.communicationService.syncContactsFromConversations(workspaceId, {
      limit: options?.limit,
    });
    return { data: result };
  }

  @Post('sync/openphone-contacts')
  @HttpCode(HttpStatus.OK)
  async syncOpenPhoneContacts(
    @WorkspaceId() workspaceId: string,
    @Body() options?: { limit?: number },
  ) {
    const result = await this.communicationService.syncContactsFromOpenPhone(workspaceId, {
      limit: options?.limit,
    });
    return { data: result };
  }

  @Get('sync/status')
  async getSyncStatus(@WorkspaceId() workspaceId: string) {
    const status = this.communicationService.getSyncStatus(workspaceId);
    return { data: status };
  }

  @Post('sync/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelSync(@WorkspaceId() workspaceId: string) {
    const result = this.communicationService.cancelSync(workspaceId);
    return { data: result };
  }

  @Delete('data')
  @HttpCode(HttpStatus.OK)
  async deleteAllData(
    @WorkspaceId() workspaceId: string,
    @Query('provider') provider?: ProviderType,
  ) {
    const result = await this.communicationService.deleteAllData(workspaceId, provider);
    return { data: result };
  }

  @Get('phone-numbers')
  async getPhoneNumbers(@WorkspaceId() workspaceId: string) {
    const phoneNumbers = await this.communicationService.getPhoneNumbers(workspaceId);
    return { data: phoneNumbers };
  }

  // ==================== TWILIO VOICE ====================

  @Get('twilio/voice-token')
  async getTwilioVoiceToken(@WorkspaceId() workspaceId: string) {
    console.log(`[VOICE TOKEN REQUEST] Workspace: ${workspaceId}`);
    const token = await this.integrationsService.generateTwilioVoiceToken(workspaceId);
    console.log(`[VOICE TOKEN RESPONSE] Token generated successfully`);
    return { data: { token } };
  }

  @Get('twilio/voice-config')
  async getTwilioVoiceConfig(@WorkspaceId() workspaceId: string) {
    const config = await this.integrationsService.getTwilioVoiceConfig(workspaceId);
    return { data: config };
  }

  @Post('twilio/voice-config/refresh')
  @HttpCode(HttpStatus.OK)
  async refreshTwilioVoiceConfig(@WorkspaceId() workspaceId: string) {
    const config = await this.integrationsService.refreshTwilioVoiceWebhook(workspaceId);
    return { data: config };
  }

  @Post('twilio/voice/twiml')
  @HttpCode(HttpStatus.OK)
  async getTwiMLForOutgoingCall(
    @WorkspaceId() workspaceId: string,
    @Body() body: { to: string; from: string; callerId?: string },
  ) {
    const twiml = await this.integrationsService.generateOutgoingCallTwiML(
      workspaceId,
      body.to,
      body.from,
      body.callerId,
    );
    return { data: { twiml } };
  }
}
