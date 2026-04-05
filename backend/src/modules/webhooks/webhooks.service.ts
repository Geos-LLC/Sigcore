import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import {
  CommunicationConversation,
} from '../../database/entities/communication-conversation.entity';
import {
  CommunicationMessage,
  MessageDirection,
  MessageStatus,
} from '../../database/entities/communication-message.entity';
import {
  CommunicationCall,
  CallDirection,
  CallStatus,
} from '../../database/entities/communication-call.entity';
import {
  CommunicationIntegration,
  ProviderType,
} from '../../database/entities/communication-integration.entity';
import { Workspace } from '../../database/entities/workspace.entity';
import { TenantPhoneNumber } from '../../database/entities/tenant-phone-number.entity';
import { EncryptionService } from '../../common/services/encryption.service';
import { EventsGateway } from '../events/events.gateway';
import { OpenPhoneProvider } from '../communication/providers/openphone.provider';
import { IdempotencyService } from './idempotency.service';
import { OutboundWebhooksService } from './outbound-webhooks.service';
import { WebhookEventType } from '../../database/entities/webhook-subscription.entity';

export interface OpenPhoneMessageObject {
  id: string;
  object: string;
  conversationId?: string;
  phoneNumberId?: string;
  direction?: string;
  from?: string;
  to?: string | string[];
  text?: string;
  content?: string;
  body?: string;
  status?: string;
  createdAt: string;
  userId?: string;
}

export interface OpenPhoneCallObject {
  id: string;
  object: string;
  phoneNumberId?: string;
  direction?: string;
  from?: string;
  to?: string;
  status?: string;
  duration?: number;
  recordingUrl?: string;
  voicemailUrl?: string;
  answeredAt?: string;
  completedAt?: string;
  createdAt: string;
  userId?: string;
}

export interface OpenPhoneWebhookPayload {
  type: string;
  data: {
    object: OpenPhoneMessageObject | OpenPhoneCallObject;
    deepLink?: string;
  };
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    @InjectRepository(CommunicationConversation)
    private conversationRepo: Repository<CommunicationConversation>,
    @InjectRepository(CommunicationMessage)
    private messageRepo: Repository<CommunicationMessage>,
    @InjectRepository(CommunicationCall)
    private callRepo: Repository<CommunicationCall>,
    @InjectRepository(CommunicationIntegration)
    private integrationRepo: Repository<CommunicationIntegration>,
    @InjectRepository(Workspace)
    private workspaceRepo: Repository<Workspace>,
    @InjectRepository(TenantPhoneNumber)
    private tenantPhoneNumberRepo: Repository<TenantPhoneNumber>,
    private encryptionService: EncryptionService,
    private eventsGateway: EventsGateway,
    private openPhoneProvider: OpenPhoneProvider,
    private idempotencyService: IdempotencyService,
    private outboundWebhooksService: OutboundWebhooksService,
  ) {}

  async getWorkspaceByWebhookId(webhookId: string): Promise<Workspace | null> {
    return this.workspaceRepo.findOne({
      where: { webhookId },
    });
  }

  async verifyOpenPhoneSignature(
    workspaceId: string,
    payload: string,
    signature: string,
  ): Promise<boolean> {
    const integration = await this.integrationRepo.findOne({
      where: { workspaceId, provider: ProviderType.OPENPHONE },
    });

    if (!integration?.webhookSecretEncrypted) {
      this.logger.warn(`No webhook secret configured for workspace: ${workspaceId}`);
      return true; // Allow if no secret configured (development mode)
    }

    const webhookSecret = this.encryptionService.decrypt(integration.webhookSecretEncrypted);

    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(payload)
      .digest('hex');

    try {
      return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature),
      );
    } catch {
      return false;
    }
  }

  // Cache for phone number lookups during webhook processing
  private phoneNumberCache = new Map<string, { number: string; name: string | null }>();

  /**
   * Resolve a phone number ID to the actual phone number and name.
   * Uses caching to avoid repeated API calls.
   * IMPORTANT: Never return the phoneNumberId as the number - always return empty string if resolution fails.
   */
  private async resolvePhoneNumber(
    workspaceId: string,
    phoneNumberId: string,
  ): Promise<{ number: string; name: string | null }> {
    // Check cache first
    const cacheKey = `${workspaceId}:${phoneNumberId}`;
    const cached = this.phoneNumberCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const integration = await this.integrationRepo.findOne({
        where: { workspaceId, provider: ProviderType.OPENPHONE },
      });

      if (!integration?.credentialsEncrypted) {
        this.logger.warn(`No integration credentials found for workspace ${workspaceId}, cannot resolve phone number ID`);
        return { number: '', name: null };
      }

      const credentialsJson = this.encryptionService.decrypt(integration.credentialsEncrypted);
      const credentials = JSON.parse(credentialsJson) as { apiKey: string };
      const client = require('axios').create({
        baseURL: 'https://api.openphone.com/v1',
        headers: {
          'Authorization': credentials.apiKey,
          'Content-Type': 'application/json',
        },
      });

      const response = await client.get('/phone-numbers');
      const phoneNumbers = response.data.data || [];

      // Find the matching phone number
      for (const pn of phoneNumbers) {
        if (pn.id === phoneNumberId) {
          const result = {
            number: pn.number || '',  // Never fall back to ID
            name: pn.name || pn.formattedNumber || null,
          };
          this.phoneNumberCache.set(cacheKey, result);
          return result;
        }
      }

      // Cache all phone numbers for future lookups
      for (const pn of phoneNumbers) {
        const key = `${workspaceId}:${pn.id}`;
        this.phoneNumberCache.set(key, {
          number: pn.number || '',  // Never fall back to ID
          name: pn.name || pn.formattedNumber || null,
        });
      }

      this.logger.warn(`Phone number ID ${phoneNumberId} not found in OpenPhone account - may have been deleted`);
      return { number: '', name: null };
    } catch (error) {
      this.logger.warn(`Failed to resolve phone number ID ${phoneNumberId}: ${error}`);
      return { number: '', name: null };
    }
  }

  async handleOpenPhoneWebhook(
    workspaceId: string,
    payload: OpenPhoneWebhookPayload,
  ): Promise<void> {
    this.logger.log(`Received OpenPhone webhook for workspace ${workspaceId}: ${payload.type}`);

    // Check idempotency - extract external ID from payload
    const externalId = (payload.data.object as any)?.id;
    if (externalId) {
      const isDuplicate = await this.idempotencyService.isDuplicate(
        'openphone',
        externalId,
        {
          eventType: payload.type,
          workspaceId,
          payload: payload as unknown as Record<string, unknown>,
        },
      );
      if (isDuplicate) {
        this.logger.log(`Skipping duplicate OpenPhone webhook: ${externalId}`);
        return;
      }
    }

    switch (payload.type) {
      case 'message.received':
      case 'message.sent':
      case 'message.delivered':
        await this.handleMessageEvent(workspaceId, payload);
        break;
      case 'call.completed':
        await this.handleCallCompletedEvent(workspaceId, payload);
        break;
      case 'voicemail.received':
        await this.handleVoicemailEvent(workspaceId, payload);
        break;
      default:
        this.logger.warn(`Unhandled webhook type: ${payload.type}`);
    }
  }

  private async handleMessageEvent(
    workspaceId: string,
    payload: OpenPhoneWebhookPayload,
  ): Promise<void> {
    // Data is nested inside data.object for OpenPhone webhooks
    const msgData = payload.data.object as OpenPhoneMessageObject;

    this.logger.log(`Processing message webhook: id=${msgData.id}, conversationId=${msgData.conversationId}, from=${msgData.from}, to=${msgData.to}`);

    const participantNumber = msgData.direction === 'incoming'
      ? msgData.from
      : (Array.isArray(msgData.to) ? msgData.to[0] : msgData.to);

    // Resolve tenantId from the phone number so webhooks are sent only to the relevant account
    // Two-step: try business-identity resolution first, fallback to tenant_phone_numbers
    let resolvedTenantId: string | undefined;
    if (msgData.phoneNumberId) {
      // Step 1: Try business-identity resolution
      try {
        const { IdentityResolutionService } = await import('../business-identity/identity-resolution.service');
        const { RoutingSelectionService } = await import('../business-identity/routing-selection.service');
        const { SharedCommunicationAsset, AssetType } = await import('../../database/entities/shared-communication-asset.entity');
        const { WorkspaceAssetLink } = await import('../../database/entities/workspace-asset-link.entity');
        const { BusinessIdentityService } = await import('../business-identity/business-identity.service');
        const { Business } = await import('../../database/entities/business.entity');
        const { ProductWorkspace } = await import('../../database/entities/product-workspace.entity');

        const { EndpointRoute } = await import('../../database/entities/endpoint-route.entity');
        const biService = new BusinessIdentityService(
          this.conversationRepo.manager.getRepository(Business),
          this.conversationRepo.manager.getRepository(ProductWorkspace),
          this.conversationRepo.manager.getRepository(SharedCommunicationAsset),
          this.conversationRepo.manager.getRepository(WorkspaceAssetLink),
          this.conversationRepo.manager.getRepository(EndpointRoute),
        );
        const identityService = new IdentityResolutionService(
          this.conversationRepo.manager.getRepository(SharedCommunicationAsset),
          this.conversationRepo.manager.getRepository(WorkspaceAssetLink),
          biService,
        );
        const routingService = new RoutingSelectionService();

        const { candidates } = await identityService.resolve({
          asset_type: AssetType.PROVIDER_NUMBER,
          normalized_value: msgData.phoneNumberId,
          provider: 'openphone',
          external_asset_id: msgData.phoneNumberId,
        });

        if (candidates.length > 0) {
          const { selected } = routingService.select(candidates, {
            channel: 'sms',
            provider: 'openphone',
          });
          if (selected) {
            // Find the tenant by external_workspace_id
            const tenant = await this.conversationRepo.manager
              .getRepository('Tenant')
              .findOne({ where: { id: selected.workspace.externalWorkspaceId } }) as any;
            if (tenant) {
              resolvedTenantId = tenant.id;
              this.logger.log(`[Routing] BI resolved tenantId=${resolvedTenantId} for phoneNumberId=${msgData.phoneNumberId} (score=${selected.score})`);
            }
          }
        }
      } catch (e) {
        this.logger.debug(`[Routing] BI resolution not available: ${e.message}`);
      }

      // Step 2: Fallback to tenant_phone_numbers
      if (!resolvedTenantId) {
        const tenantPhone = await this.tenantPhoneNumberRepo.findOne({
          where: { workspaceId, providerId: msgData.phoneNumberId },
        });
        if (tenantPhone) {
          resolvedTenantId = tenantPhone.tenantId;
          this.logger.log(`[Routing] Fallback: tenantId=${resolvedTenantId} from phoneNumberId=${msgData.phoneNumberId}`);
        }
      }
    }

    let conversation: CommunicationConversation | null = null;

    // First try to find by conversationId if available
    if (msgData.conversationId) {
      conversation = await this.conversationRepo.findOne({
        where: {
          workspaceId,
          externalId: msgData.conversationId,
        },
      });
    }

    // If not found by conversationId, try to find by participant phone number AND phone line
    // We need to match both the participant AND the phone line to avoid mixing conversations
    if (!conversation && participantNumber && msgData.phoneNumberId) {
      // First try: find by phone number ID in metadata
      const conversations = await this.conversationRepo
        .createQueryBuilder('conv')
        .where('conv.workspaceId = :workspaceId', { workspaceId })
        .andWhere('conv.participantPhoneNumber = :participant', { participant: participantNumber })
        .andWhere("conv.metadata->>'phoneNumberId' = :phoneNumberId", { phoneNumberId: msgData.phoneNumberId })
        .getMany();

      if (conversations.length > 0) {
        conversation = conversations[0];
        this.logger.log(`Found conversation ${conversation.id} by participant+phoneNumberId`);
      }
    }

    // Fallback: if still not found, try by participant only (for backwards compatibility)
    // but only if there's no phoneNumberId to match against
    if (!conversation && participantNumber && !msgData.phoneNumberId) {
      conversation = await this.conversationRepo.findOne({
        where: {
          workspaceId,
          participantPhoneNumber: participantNumber,
        },
      });
    }

    // Update existing conversation's phoneNumber if it's still an ID (starts with PN)
    if (conversation && msgData.phoneNumberId) {
      const currentPhoneNumber = conversation.phoneNumber;
      const metadata = conversation.metadata as Record<string, unknown> || {};

      // Check if phoneNumber looks like an ID (starts with PN or is empty)
      if (!currentPhoneNumber || currentPhoneNumber.startsWith('PN') || !metadata.phoneNumberName) {
        this.logger.log(`Updating conversation ${conversation.id} phone number from "${currentPhoneNumber}" (ID: ${msgData.phoneNumberId})`);
        const phoneInfo = await this.resolvePhoneNumber(workspaceId, msgData.phoneNumberId);
        conversation.phoneNumber = phoneInfo.number;
        conversation.metadata = {
          ...metadata,
          phoneNumberId: msgData.phoneNumberId,
          phoneNumberName: phoneInfo.name,
        };
        await this.conversationRepo.save(conversation);
        this.logger.log(`Updated conversation ${conversation.id} phone to "${phoneInfo.number}" (name: ${phoneInfo.name})`);
      }
    }

    // Contact linking now handled in Callio service
    let contactName: string | undefined;

    // Create new conversation if none exists
    let isNewConversation = false;
    if (!conversation && participantNumber) {
      const externalId = msgData.conversationId || `webhook_${msgData.id}`;
      this.logger.log(`Creating new conversation for participant: ${participantNumber}, externalId: ${externalId}`);

      // Resolve the phone number ID to actual phone number and name
      const phoneInfo = msgData.phoneNumberId
        ? await this.resolvePhoneNumber(workspaceId, msgData.phoneNumberId)
        : { number: '', name: null };

      conversation = this.conversationRepo.create({
        workspaceId,
        externalId,
        provider: ProviderType.OPENPHONE,
        phoneNumber: phoneInfo.number,
        participantPhoneNumber: participantNumber,
        metadata: {
          phoneNumberId: msgData.phoneNumberId,
          phoneNumberName: phoneInfo.name,
        },
      });

      // Contact linking now handled in Callio service

      await this.conversationRepo.save(conversation);
      isNewConversation = true;
    }

    if (!conversation) {
      this.logger.warn(`Could not find or create conversation - missing participant number. Data: ${JSON.stringify(msgData)}`);
      return;
    }

    // SECURITY: Include workspace context in deduplication to prevent cross-workspace data leaks
    const existingMessage = await this.messageRepo
      .createQueryBuilder('msg')
      .innerJoin('msg.conversation', 'conv')
      .where('msg.providerMessageId = :providerId', { providerId: msgData.id })
      .andWhere('conv.workspaceId = :workspaceId', { workspaceId })
      .getOne();

    if (existingMessage) {
      existingMessage.status = this.mapMessageStatus(msgData.status);
      await this.messageRepo.save(existingMessage);

      // Fire outbound webhook for status updates (delivered, failed) so LeadBridge
      // subscribers receive delivery receipts — not just initial message.sent events.
      const statusEventType = existingMessage.status === MessageStatus.DELIVERED
        ? WebhookEventType.MESSAGE_DELIVERED
        : WebhookEventType.MESSAGE_SENT;
      this.outboundWebhooksService
        .emitMessageEvent(workspaceId, statusEventType, existingMessage, undefined, resolvedTenantId)
        .catch((err) => {
          this.logger.error(`Failed to emit status-update webhook for message ${existingMessage.id}: ${err.message}`);
        });

      return;
    }

    const message = this.messageRepo.create({
      conversationId: conversation.id,
      direction: msgData.direction === 'incoming' ? MessageDirection.IN : MessageDirection.OUT,
      body: msgData.text || msgData.content || msgData.body || '',
      fromNumber: msgData.from || '',
      toNumber: Array.isArray(msgData.to) ? msgData.to[0] : (msgData.to || ''),
      providerMessageId: msgData.id,
      status: this.mapMessageStatus(msgData.status),
    });

    await this.messageRepo.save(message);
    this.logger.log(`Saved message ${msgData.id} to conversation ${conversation.id}`);

    // Emit real-time event to connected clients
    this.eventsGateway.emitNewMessage(workspaceId, {
      id: message.id,
      conversationId: conversation.id,
      direction: message.direction,
      body: message.body,
      fromNumber: message.fromNumber,
      toNumber: message.toNumber,
      providerMessageId: message.providerMessageId,
      status: message.status,
      createdAt: message.createdAt,
    });

    // Emit conversation event - new or update
    const metadata = conversation.metadata as Record<string, unknown> || {};
    if (isNewConversation) {
      this.eventsGateway.emitNewConversation(workspaceId, {
        id: conversation.id,
        externalId: conversation.externalId,
        phoneNumber: conversation.phoneNumber,
        phoneNumberName: metadata.phoneNumberName as string || null,
        participantPhoneNumber: conversation.participantPhoneNumber,
        contactId: conversation.contactId,
        contactName,
        lastMessage: message.body,
        lastMessageAt: message.createdAt,
        unreadCount: 1,
      });
    } else {
      this.eventsGateway.emitConversationUpdate(workspaceId, {
        id: conversation.id,
        externalId: conversation.externalId,
        phoneNumber: conversation.phoneNumber,
        phoneNumberName: metadata.phoneNumberName as string || null,
        participantPhoneNumber: conversation.participantPhoneNumber,
        contactId: conversation.contactId,
        contactName,
        lastMessage: message.body,
        lastMessageAt: message.createdAt,
      });
    }

    // Emit outbound webhook to subscriptions (fire and forget)
    const webhookEventType = message.direction === MessageDirection.IN
      ? WebhookEventType.MESSAGE_INBOUND
      : message.status === MessageStatus.DELIVERED
        ? WebhookEventType.MESSAGE_DELIVERED
        : WebhookEventType.MESSAGE_SENT;

    this.outboundWebhooksService
      .emitMessageEvent(workspaceId, webhookEventType, message, undefined, resolvedTenantId)
      .catch((err) => {
        this.logger.error(`Failed to emit outbound webhook for OpenPhone message: ${err.message}`);
      });
  }

  private async handleCallCompletedEvent(
    workspaceId: string,
    payload: OpenPhoneWebhookPayload,
  ): Promise<void> {
    // Data is nested inside data.object for OpenPhone webhooks
    const callData = payload.data.object as OpenPhoneCallObject;

    const participantNumber = callData.direction === 'incoming'
      ? callData.from
      : (typeof callData.to === 'string' ? callData.to : '');

    let isNewConversation = false;
    let contactName: string | undefined;
    let conversation = await this.conversationRepo.findOne({
      where: {
        workspaceId,
        participantPhoneNumber: participantNumber || '',
      },
    });

    // Update existing conversation's phoneNumber if it's still an ID (starts with PN)
    if (conversation && callData.phoneNumberId) {
      const currentPhoneNumber = conversation.phoneNumber;
      const metadata = conversation.metadata as Record<string, unknown> || {};

      // Check if phoneNumber looks like an ID (starts with PN or is empty)
      if (!currentPhoneNumber || currentPhoneNumber.startsWith('PN') || !metadata.phoneNumberName) {
        this.logger.log(`Updating call conversation ${conversation.id} phone number from "${currentPhoneNumber}"`);
        const phoneInfo = await this.resolvePhoneNumber(workspaceId, callData.phoneNumberId);
        conversation.phoneNumber = phoneInfo.number;
        conversation.metadata = {
          ...metadata,
          phoneNumberId: callData.phoneNumberId,
          phoneNumberName: phoneInfo.name,
        };
        await this.conversationRepo.save(conversation);
        this.logger.log(`Updated call conversation ${conversation.id} phone to "${phoneInfo.number}" (name: ${phoneInfo.name})`);
      }
    }

    // Contact linking now handled in Callio service

    if (!conversation) {
      // Resolve the phone number ID to actual phone number and name
      const phoneInfo = callData.phoneNumberId
        ? await this.resolvePhoneNumber(workspaceId, callData.phoneNumberId)
        : { number: '', name: null };

      conversation = this.conversationRepo.create({
        workspaceId,
        externalId: `call_${callData.id}`,
        provider: ProviderType.OPENPHONE,
        phoneNumber: phoneInfo.number,
        participantPhoneNumber: participantNumber || '',
        metadata: {
          phoneNumberId: callData.phoneNumberId,
          phoneNumberName: phoneInfo.name,
        },
      });

      // Contact linking now handled in Callio service

      await this.conversationRepo.save(conversation);
      isNewConversation = true;
    }

    // SECURITY: Include workspace context in deduplication to prevent cross-workspace data leaks
    const existingCall = await this.callRepo
      .createQueryBuilder('call')
      .innerJoin('call.conversation', 'conv')
      .where('call.providerCallId = :providerId', { providerId: callData.id })
      .andWhere('conv.workspaceId = :workspaceId', { workspaceId })
      .getOne();

    if (existingCall) {
      return;
    }

    const call = this.callRepo.create({
      conversationId: conversation.id,
      direction: callData.direction === 'incoming' ? CallDirection.IN : CallDirection.OUT,
      duration: callData.duration || 0,
      fromNumber: callData.from || '',
      toNumber: typeof callData.to === 'string' ? callData.to : '',
      providerCallId: callData.id,
      status: this.mapCallStatus(callData.status, callData.voicemailUrl),
      recordingUrl: callData.recordingUrl,
      voicemailUrl: callData.voicemailUrl,
      startedAt: callData.answeredAt ? new Date(callData.answeredAt) : undefined,
      endedAt: callData.completedAt ? new Date(callData.completedAt) : undefined,
    });

    await this.callRepo.save(call);
    this.logger.log(`Saved call ${callData.id} to conversation ${conversation.id}`);

    // Emit real-time event to connected clients
    this.eventsGateway.emitNewCall(workspaceId, {
      id: call.id,
      conversationId: conversation.id,
      direction: call.direction,
      duration: call.duration,
      fromNumber: call.fromNumber,
      toNumber: call.toNumber,
      providerCallId: call.providerCallId,
      status: call.status,
      recordingUrl: call.recordingUrl,
      voicemailUrl: call.voicemailUrl,
      startedAt: call.startedAt,
      endedAt: call.endedAt,
      createdAt: call.createdAt,
    });

    // Emit conversation event - new or update
    const callMetadata = conversation.metadata as Record<string, unknown> || {};
    if (isNewConversation) {
      this.eventsGateway.emitNewConversation(workspaceId, {
        id: conversation.id,
        externalId: conversation.externalId,
        phoneNumber: conversation.phoneNumber,
        phoneNumberName: callMetadata.phoneNumberName as string || null,
        participantPhoneNumber: conversation.participantPhoneNumber,
        contactId: conversation.contactId,
        contactName,
        lastMessage: null,
        lastMessageAt: null,
        unreadCount: 0,
      });
    } else {
      this.eventsGateway.emitConversationUpdate(workspaceId, {
        id: conversation.id,
        externalId: conversation.externalId,
        phoneNumber: conversation.phoneNumber,
        phoneNumberName: callMetadata.phoneNumberName as string || null,
        participantPhoneNumber: conversation.participantPhoneNumber,
        contactId: conversation.contactId,
        contactName,
      });
    }

    // Emit outbound webhook for call event (fire and forget)
    const callWebhookEvent = call.status === CallStatus.MISSED
      ? WebhookEventType.CALL_MISSED
      : WebhookEventType.CALL_COMPLETED;

    this.outboundWebhooksService
      .emitEvent(workspaceId, callWebhookEvent, {
        callId: call.id,
        conversationId: conversation.id,
        direction: call.direction,
        duration: call.duration,
        fromNumber: call.fromNumber,
        toNumber: call.toNumber,
        providerCallId: call.providerCallId,
        status: call.status,
        recordingUrl: call.recordingUrl,
        voicemailUrl: call.voicemailUrl,
        startedAt: call.startedAt,
        endedAt: call.endedAt,
        createdAt: call.createdAt,
      })
      .catch((err) => {
        this.logger.error(`Failed to emit outbound webhook for OpenPhone call: ${err.message}`);
      });
  }

  private async handleVoicemailEvent(
    workspaceId: string,
    payload: OpenPhoneWebhookPayload,
  ): Promise<void> {
    (payload.data.object as OpenPhoneCallObject).status = 'voicemail';
    await this.handleCallCompletedEvent(workspaceId, payload);
  }

  private mapMessageStatus(status?: string): MessageStatus {
    const statusMap: Record<string, MessageStatus> = {
      'delivered': MessageStatus.DELIVERED,
      'sent': MessageStatus.SENT,
      'failed': MessageStatus.FAILED,
      'pending': MessageStatus.PENDING,
    };
    return statusMap[status || ''] || MessageStatus.PENDING;
  }

  private mapCallStatus(status?: string, voicemailUrl?: string): CallStatus {
    if (voicemailUrl) {
      return CallStatus.VOICEMAIL;
    }
    const statusMap: Record<string, CallStatus> = {
      'completed': CallStatus.COMPLETED,
      'missed': CallStatus.MISSED,
      'cancelled': CallStatus.CANCELLED,
      'voicemail': CallStatus.VOICEMAIL,
    };
    return statusMap[status || ''] || CallStatus.COMPLETED;
  }

}
