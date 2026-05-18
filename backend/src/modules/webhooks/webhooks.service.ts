import { Injectable, Logger, Inject, forwardRef, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
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
import { TenantIntegration } from '../../database/entities/tenant-integration.entity';
import { WebhookSubscription, WebhookSubscriptionStatus } from '../../database/entities/webhook-subscription.entity';
import { EncryptionService } from '../../common/services/encryption.service';
import { EventsGateway } from '../events/events.gateway';
import { OpenPhoneProvider } from '../communication/providers/openphone.provider';
import { IdempotencyService } from './idempotency.service';
import { OutboundWebhooksService } from './outbound-webhooks.service';
import { WebhookEventType } from '../../database/entities/webhook-subscription.entity';
import { S3Service } from '../../shared/storage/s3.service';
import { OpenPhoneContactCacheService } from '../integrations/openphone-contact-cache.service';
import { normalizeToE164 } from '../../common/util/phone';
import { ResolveProfileForInboundService } from '../routing/resolve-profile-for-inbound.service';

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
    @InjectRepository(TenantIntegration)
    private tenantIntegrationRepo: Repository<TenantIntegration>,
    @InjectRepository(WebhookSubscription)
    private webhookSubscriptionRepo: Repository<WebhookSubscription>,
    private encryptionService: EncryptionService,
    private eventsGateway: EventsGateway,
    private openPhoneProvider: OpenPhoneProvider,
    private idempotencyService: IdempotencyService,
    private outboundWebhooksService: OutboundWebhooksService,
    private s3Service: S3Service,
    @Optional()
    @Inject(forwardRef(() => OpenPhoneContactCacheService))
    private openPhoneContactCache?: OpenPhoneContactCacheService,
    @Optional()
    private inboundResolver?: ResolveProfileForInboundService,
  ) {}

  /**
   * Called after every inbound OpenPhone message/call webhook. Creates or updates
   * a participant for the conversation and schedules a debounced background
   * contact sync so new/updated Quo contacts land in Sigcore's cache without
   * manual intervention.
   */
  private async linkOpenPhoneParticipantFromWebhook(
    conversation: CommunicationConversation,
  ): Promise<void> {
    if (!this.openPhoneContactCache) return;
    if (conversation.provider !== ProviderType.OPENPHONE) return;
    if (!conversation.participantPhoneNumber) return;

    const { e164 } = normalizeToE164(conversation.participantPhoneNumber);
    if (!e164) return;

    let tenantId = conversation.tenantId;
    let tenantWasBackfilled = false;
    if (!tenantId) {
      tenantId = await this.openPhoneContactCache.resolveOpenPhoneTenant(conversation.workspaceId);
      if (!tenantId) return;
      tenantWasBackfilled = true;
    }

    try {
      const providerAccountId = (conversation.metadata as Record<string, unknown> | null)?.phoneNumberId as string | undefined
        ?? await this.openPhoneContactCache.sniffProviderAccountId(conversation.workspaceId, tenantId);

      const participant = await this.openPhoneContactCache.upsertParticipantFromConversation({
        workspaceId: conversation.workspaceId,
        tenantId,
        providerAccountId,
        phoneE164: e164,
        rawPhone: conversation.participantPhoneNumber,
      });

      const updates: Partial<CommunicationConversation> = {};
      if (conversation.participantId !== participant.id) updates.participantId = participant.id;
      if (conversation.participantKey !== participant.participantKey) updates.participantKey = participant.participantKey;
      if (conversation.participantPhoneE164 !== e164) updates.participantPhoneE164 = e164;
      if (tenantWasBackfilled) updates.tenantId = tenantId;
      if (Object.keys(updates).length > 0) {
        await this.conversationRepo.update(conversation.id, updates as any);
        Object.assign(conversation, updates);
      }

      // Refresh snapshot cache in the background (debounced). Self-healing:
      // new contacts created in Quo between syncs become available to subsequent
      // reads within a few seconds of an inbound webhook.
      this.openPhoneContactCache.scheduleBackgroundSync(conversation.workspaceId, tenantId);
    } catch (e) {
      this.logger.warn(`linkOpenPhoneParticipantFromWebhook failed for conv ${conversation.id}: ${(e as Error).message}`);
    }
  }

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

    // Source C — link participant for every inbound message, regardless of
    // whether the conversation existed or was just created.
    if (conversation) {
      await this.linkOpenPhoneParticipantFromWebhook(conversation);
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

      // Status-update path: pass through profile/business already on the
      // conversation so additive fan-out works for delivery receipts too.
      const statusEventType = existingMessage.status === MessageStatus.DELIVERED
        ? WebhookEventType.MESSAGE_DELIVERED
        : WebhookEventType.MESSAGE_SENT;
      this.outboundWebhooksService
        .emitMessageEvent(workspaceId, statusEventType, existingMessage, undefined, {
          tenantId: conversation.tenantId ?? resolvedTenantId ?? undefined,
          businessId: conversation.communicationBusinessId ?? undefined,
          profileId: conversation.communicationProfileId ?? undefined,
        })
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

    // Tag conversation with profile/business via the routing resolver, then
    // emit the webhook with full scope for additive fan-out.
    let resolvedScope: {
      tenantId?: string;
      businessId?: string;
      profileId?: string;
    } = { tenantId: resolvedTenantId };

    if (this.inboundResolver) {
      try {
        // Pre-set tenantId on the conversation so the resolver doesn't have
        // to look it up again via tenant_phone_numbers.
        if (resolvedTenantId && !conversation.tenantId) {
          conversation.tenantId = resolvedTenantId;
        }
        const r = await this.inboundResolver.resolveAndApplyToConversation(conversation);
        resolvedScope = {
          tenantId: r.tenantId ?? resolvedTenantId,
          businessId: r.businessId ?? undefined,
          profileId: r.profileId ?? undefined,
        };
        if (r.profileId) {
          this.logger.log(
            `[openphone] resolved scope tenant=${r.tenantId?.slice(0, 8) ?? '-'} profile=${r.profileId.slice(0, 8)} business=${r.businessId?.slice(0, 8) ?? '-'} confidence=${r.confidence}`,
          );
        }
      } catch (err) {
        this.logger.error(`[openphone] inbound resolver failed: ${(err as Error).message}`);
      }
    }

    // Emit outbound webhook to subscriptions (fire and forget)
    const webhookEventType = message.direction === MessageDirection.IN
      ? WebhookEventType.MESSAGE_INBOUND
      : message.status === MessageStatus.DELIVERED
        ? WebhookEventType.MESSAGE_DELIVERED
        : WebhookEventType.MESSAGE_SENT;

    this.outboundWebhooksService
      .emitMessageEvent(workspaceId, webhookEventType, message, undefined, resolvedScope)
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

    // Source C — link participant for every inbound call.
    if (conversation) {
      await this.linkOpenPhoneParticipantFromWebhook(conversation);
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

    // Emit outbound webhook to subscriptions (fire and forget)
    const callWebhookType = WebhookEventType.CALL_COMPLETED;
    this.outboundWebhooksService
      .emitEvent(workspaceId, callWebhookType, {
        callId: call.id,
        providerCallId: call.providerCallId,
        conversationId: conversation.id,
        direction: call.direction,
        duration: call.duration,
        fromNumber: call.fromNumber,
        toNumber: call.toNumber,
        status: call.status,
        recordingUrl: call.recordingUrl || null,
        voicemailUrl: call.voicemailUrl || null,
        phoneNumberId: callData.phoneNumberId,
        createdAt: call.createdAt?.toISOString(),
      })
      .catch((err) => {
        this.logger.error(`Failed to emit call webhook: ${err.message}`);
      });

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

  // ==================== WHATSAPP WEBHOOK HANDLER ====================

  async handleWhatsAppWebhook(
    workspaceId: string,
    eventType: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    this.logger.log(`[WhatsApp] Processing ${eventType} for workspace ${workspaceId}`);

    switch (eventType) {
      case 'contacts_sync':
        await this.handleWhatsAppContactsSync(workspaceId, data);
        break;
      case 'message_inbound':
        await this.handleWhatsAppInboundMessage(workspaceId, data);
        break;
      case 'message_outbound':
        // Outbound messages are already tracked when sent via Sigcore API
        // This callback confirms delivery from the WhatsApp service
        this.logger.debug(`[WhatsApp] Outbound message confirmed: ${data.externalMessageId}`);
        break;
      case 'message_ack':
        await this.handleWhatsAppMessageAck(workspaceId, data);
        break;
      case 'status_change':
        this.logger.log(`[WhatsApp] Status change for workspace ${workspaceId}: ${data.status}`);
        // PR3: Do NOT wipe conversations/messages on reconnect. The sync pipeline
        // upserts by providerMessageId, and media persisted to S3 survives redeploys.
        // Wiping here caused every redeploy to re-download every photo.
        await this.outboundWebhooksService.emitEvent(
          workspaceId,
          WebhookEventType.WHATSAPP_STATUS_CHANGE,
          { workspaceId, provider: 'whatsapp', ...data },
        );
        break;
      default:
        this.logger.debug(`[WhatsApp] Unhandled event type: ${eventType}`);
    }
  }

  // ===== Telegram (issue #1) =========================================
  /**
   * Telegram connector → Sigcore.
   *
   * Sigcore owns conversations/identities/messages.  This handler is the
   * landing pad — it currently logs the inbound event and fans it onto the
   * outbound webhook bus so TelePorter / LeadBridge can consume.  Extending
   * `CommunicationConversation` / `CommunicationMessage` schemas to persist
   * Telegram rows is a focused follow-up (see issue rollout, Phase 2 close).
   *
   * The connector does *not* migrate TelePorter's MTProto sessions; gate is
   * `TELEPORTER_SIGCORE_TELEGRAM_ENABLED` on the TelePorter side.  See issue
   * #1 ("MUST NOT migrate existing Telegram sessions into Sigcore core").
   */
  async handleTelegramInbound(payload: {
    tenantId: string;
    provider: 'telegram';
    accountId: string;
    message: Record<string, unknown>;
  }): Promise<void> {
    if (!payload?.tenantId || !payload?.accountId || !payload?.message) {
      this.logger.warn('[Telegram] invalid inbound payload');
      return;
    }
    this.logger.log(
      `[Telegram] inbound message tenant=${payload.tenantId} account=${payload.accountId} ` +
        `extId=${(payload.message as Record<string, unknown>).externalMessageId}`,
    );

    // Find the workspace this tenant belongs to so existing fan-out can
    // dispatch to subscriptions.  When no workspace mapping exists we still
    // log; downstream wiring (LeadBridge etc.) operates by tenantId.
    const workspaceId = await this.resolveTelegramWorkspaceId(payload.tenantId);

    if (workspaceId) {
      await this.outboundWebhooksService.emitEvent(
        workspaceId,
        WebhookEventType.TELEGRAM_MESSAGE_RECEIVED,
        {
          tenantId: payload.tenantId,
          provider: 'telegram',
          accountId: payload.accountId,
          message: payload.message,
        },
        { tenantId: payload.tenantId },
      );
    }
  }

  async handleTelegramProviderEvent(event: {
    eventType: string;
    tenantId: string;
    accountId: string;
    occurredAt: string;
    data: Record<string, unknown>;
  }): Promise<void> {
    if (!event?.tenantId || !event?.accountId) return;
    const map: Record<string, WebhookEventType> = {
      'provider.account.connected': WebhookEventType.TELEGRAM_ACCOUNT_CONNECTED,
      'provider.account.disconnected': WebhookEventType.TELEGRAM_ACCOUNT_DISCONNECTED,
      'message.received': WebhookEventType.TELEGRAM_MESSAGE_RECEIVED,
      'message.sent': WebhookEventType.TELEGRAM_MESSAGE_SENT,
      'message.failed': WebhookEventType.TELEGRAM_MESSAGE_FAILED,
      'conversation.updated': WebhookEventType.TELEGRAM_CONVERSATION_UPDATED,
    };
    const mapped = map[event.eventType];
    if (!mapped) {
      this.logger.debug(`[Telegram] unhandled provider event ${event.eventType}`);
      return;
    }

    const workspaceId = await this.resolveTelegramWorkspaceId(event.tenantId);
    if (!workspaceId) return;

    await this.outboundWebhooksService.emitEvent(
      workspaceId,
      mapped,
      {
        tenantId: event.tenantId,
        provider: 'telegram',
        accountId: event.accountId,
        occurredAt: event.occurredAt,
        ...event.data,
      },
      { tenantId: event.tenantId },
    );
  }

  private async resolveTelegramWorkspaceId(tenantId: string): Promise<string | undefined> {
    if (!tenantId) return undefined;
    try {
      const tenant = await this.conversationRepo.manager
        .getRepository('Tenant')
        .findOne({ where: { id: tenantId } }) as { workspaceId?: string } | null;
      return tenant?.workspaceId;
    } catch (e) {
      this.logger.debug(`[Telegram] tenant lookup failed: ${e instanceof Error ? e.message : 'unknown'}`);
      return undefined;
    }
  }

  /**
   * Delete all WhatsApp conversations + messages for a workspace.
   * Called on reconnect so fresh sync replaces stale data.
   */
  private async clearWhatsAppData(workspaceId: string): Promise<void> {
    this.logger.log(`[WhatsApp] Clearing old WhatsApp data for workspace ${workspaceId}`);

    // Find all WhatsApp conversations for this workspace
    const conversations = await this.conversationRepo.find({
      where: { workspaceId, provider: ProviderType.WHATSAPP },
      select: ['id'],
    });

    if (conversations.length === 0) {
      this.logger.log(`[WhatsApp] No existing WhatsApp data to clear`);
      return;
    }

    const conversationIds = conversations.map(c => c.id);

    // Delete messages for these conversations
    const msgResult = await this.messageRepo
      .createQueryBuilder()
      .delete()
      .where('conversationId IN (:...ids)', { ids: conversationIds })
      .execute();

    // Delete conversations
    const convResult = await this.conversationRepo
      .createQueryBuilder()
      .delete()
      .where('id IN (:...ids)', { ids: conversationIds })
      .execute();

    this.logger.log(
      `[WhatsApp] Cleared ${convResult.affected || 0} conversations and ${msgResult.affected || 0} messages`,
    );
  }

  private mimeToExt(mime: string): string {
    const map: Record<string, string> = {
      'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
      'video/mp4': '.mp4', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a',
      'application/pdf': '.pdf', 'application/octet-stream': '.bin',
    };
    return map[mime] || '.bin';
  }

  /**
   * Handle contacts_sync: create/update conversations with contact names + avatars
   * before messages arrive, so conversations show names immediately.
   */
  private async handleWhatsAppContactsSync(
    workspaceId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const contacts = data.contacts as Array<{
      phone: string;
      externalChatId: string;
      name: string | null;
      avatarUrl: string | null;
      isGroup?: boolean;
      lastActivityAt?: string | null;
      lastMessagePreview?: string | null;
      unreadCount?: number;
    }>;
    const sessionPhone = data.sessionPhone as string || '';

    if (!contacts || !Array.isArray(contacts)) return;

    this.logger.log(`[WhatsApp] Syncing ${contacts.length} contacts for workspace ${workspaceId} (session: ${sessionPhone})`);

    for (const contact of contacts) {
      if (!contact.phone) continue;

      // Don't add + prefix to group IDs (@g.us) — they're not phone numbers
      const isGroupContact = contact.isGroup || contact.phone.includes('@');
      const normalizedPhone = isGroupContact
        ? contact.phone
        : (contact.phone.startsWith('+') ? contact.phone : `+${contact.phone}`);

      // Find existing conversation for this participant
      let conversation = await this.conversationRepo.findOne({
        where: {
          workspaceId,
          participantPhoneNumber: normalizedPhone,
          provider: ProviderType.WHATSAPP,
        },
      });

      const meta: Record<string, unknown> = {
        externalChatId: contact.externalChatId,
        ...(contact.name && { contactName: contact.name }),
        ...(contact.avatarUrl && { avatarUrl: contact.avatarUrl }),
        ...(contact.isGroup && { isGroup: true }),
        ...(contact.lastActivityAt && { lastActivityAt: contact.lastActivityAt }),
        ...(contact.lastMessagePreview && { lastMessagePreview: contact.lastMessagePreview }),
        unreadCount: contact.unreadCount || 0,
      };

      if (!conversation) {
        try {
          conversation = this.conversationRepo.create({
            workspaceId,
            tenantId: null,
            externalId: contact.externalChatId || `wa_conv_${Date.now()}_${Math.random().toString(36).substring(7)}`,
            provider: ProviderType.WHATSAPP,
            channel: 'whatsapp' as any,
            phoneNumber: sessionPhone || normalizedPhone,
            participantPhoneNumber: normalizedPhone,
            metadata: meta,
          });
          await this.conversationRepo.save(conversation);
        } catch (e: any) {
          if (e.code === '23505' || e.message?.includes('duplicate') || e.message?.includes('unique')) {
            conversation = await this.conversationRepo.findOne({
              where: { workspaceId, participantPhoneNumber: normalizedPhone, provider: ProviderType.WHATSAPP },
            });
          }
          if (!conversation) continue;
        }
      } else {
        // Update existing conversation with all metadata
        const existingMeta = (conversation.metadata as Record<string, unknown>) || {};
        let changed = false;
        if (contact.name && existingMeta.contactName !== contact.name) {
          existingMeta.contactName = contact.name; changed = true;
        }
        if (contact.avatarUrl) {
          existingMeta.avatarUrl = contact.avatarUrl; changed = true;
        }
        if (contact.lastActivityAt) {
          existingMeta.lastActivityAt = contact.lastActivityAt; changed = true;
        }
        if (contact.lastMessagePreview) {
          existingMeta.lastMessagePreview = contact.lastMessagePreview; changed = true;
        }
        if (contact.isGroup) {
          existingMeta.isGroup = true; changed = true;
        }
        if (contact.unreadCount !== undefined) {
          existingMeta.unreadCount = contact.unreadCount; changed = true;
        }
        if (sessionPhone && !contact.isGroup && conversation.phoneNumber !== sessionPhone) {
          conversation.phoneNumber = sessionPhone; changed = true;
        }
        if (changed) {
          conversation.metadata = existingMeta;
          await this.conversationRepo.save(conversation);
        }
      }
    }

    this.logger.log(`[WhatsApp] Contacts sync complete for workspace ${workspaceId}`);
  }

  /**
   * Resolve the tenant that owns the WhatsApp integration on this workspace.
   *
   * Preference order:
   *   1. explicit `tenant_integrations` row (workspace + provider=whatsapp)
   *   2. sole tenant with an active webhook subscription listing any `whatsapp.*` event
   *   3. null (not determinable — conversation stays workspace-wide)
   */
  private async resolveWhatsAppTenantId(workspaceId: string): Promise<string | null> {
    try {
      const rows = await this.tenantIntegrationRepo.find({
        where: { workspaceId, provider: ProviderType.WHATSAPP },
      });
      if (rows.length === 1) return rows[0].tenantId;
      if (rows.length > 1) {
        this.logger.warn(`[WhatsApp] Multiple tenant_integrations for workspace ${workspaceId} — cannot unambiguously tag tenant_id`);
        return null;
      }
    } catch (e) {
      this.logger.debug(`[WhatsApp] tenant_integrations lookup failed: ${e instanceof Error ? e.message : 'unknown'}`);
    }

    // Fallback: infer from webhook subscriptions listing any whatsapp.* event.
    try {
      const subs = await this.webhookSubscriptionRepo.find({
        where: [
          { workspaceId, status: WebhookSubscriptionStatus.ACTIVE },
          { workspaceId, status: WebhookSubscriptionStatus.PAUSED },
        ],
      });
      const whatsAppSubs = subs.filter(s => (s.events || []).some(e => e.startsWith('whatsapp.')));
      const tenantIds = Array.from(new Set(whatsAppSubs.map(s => s.tenantId).filter(Boolean))) as string[];
      if (tenantIds.length === 1) {
        this.logger.log(`[WhatsApp] Inferred tenantId=${tenantIds[0]} from webhook subscription on workspace ${workspaceId}`);
        return tenantIds[0];
      }
    } catch (e) {
      this.logger.debug(`[WhatsApp] subscription inference failed: ${e instanceof Error ? e.message : 'unknown'}`);
    }

    return null;
  }

  private async handleWhatsAppInboundMessage(
    workspaceId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const from = data.from as string;
    const to = data.to as string;
    const body = data.body as string;
    const externalMessageId = data.externalMessageId as string;
    const externalChatId = data.externalChatId as string;

    if (!from || !body) {
      this.logger.warn('[WhatsApp] Missing from or body in inbound message');
      return;
    }

    // Resolve tenant up-front so both dedup-backfill and new-insert branches can use it
    const resolvedTenantId = await this.resolveWhatsAppTenantId(workspaceId);

    // Dedup: skip if we already have this message (message_create + message events fire for same msg,
    // and auto-sync can re-forward messages already received in real-time)
    if (externalMessageId) {
      const existing = await this.messageRepo.findOne({
        where: { providerMessageId: externalMessageId },
      });
      if (existing) {
        this.logger.debug(`[WhatsApp] Dedup: message ${externalMessageId} already exists, skipping`);
        // Backfill tenant_id on the existing conversation if it was created pre-fix
        if (resolvedTenantId && existing.conversationId) {
          await this.conversationRepo.update(
            { id: existing.conversationId, tenantId: null as any },
            { tenantId: resolvedTenantId } as any,
          );
        }
        return;
      }
    }

    // Normalize phone numbers (don't add + to group IDs or @-style identifiers)
    const normalizedFrom = from.includes('@') ? from : (from.startsWith('+') ? from : `+${from}`);
    const normalizedTo = !to ? '' : (to.includes('@') ? to : (to.startsWith('+') ? to : `+${to}`));
    const isFromMe = data.fromMe === true;
    const isGroup = data.isGroup === true;

    // For groups: participant = group ID (externalChatId), ownPhone = session phone
    // For individual: participant = the OTHER person, ownPhone = me
    let participantPhone: string;
    let ownPhone: string;

    if (isGroup) {
      participantPhone = externalChatId || normalizedFrom;
      ownPhone = normalizedTo || normalizedFrom;
    } else {
      participantPhone = isFromMe ? normalizedTo : normalizedFrom;
      ownPhone = isFromMe ? normalizedFrom : normalizedTo;
    }

    if (!participantPhone) {
      this.logger.warn('[WhatsApp] Could not determine participant phone');
      return;
    }

    // Find or create conversation by participant (the contact), not by "from"
    let conversation = await this.conversationRepo.findOne({
      where: {
        workspaceId,
        participantPhoneNumber: participantPhone,
        provider: ProviderType.WHATSAPP,
      },
    });

    const contactName = data.contactName as string || null;

    if (!conversation) {
      try {
        conversation = this.conversationRepo.create({
          workspaceId,
          tenantId: resolvedTenantId,
          externalId: externalChatId || `wa_conv_${Date.now()}_${Math.random().toString(36).substring(7)}`,
          provider: ProviderType.WHATSAPP,
          channel: 'whatsapp' as any,
          phoneNumber: ownPhone,
          participantPhoneNumber: participantPhone,
          metadata: { externalChatId, ...(contactName && { contactName }) },
        });
        await this.conversationRepo.save(conversation);
        this.logger.log(`[WhatsApp] Created conversation ${conversation.id} for ${normalizedFrom} (tenant=${resolvedTenantId || 'null'})`);
      } catch (e: any) {
        // Race condition: another request created the same conversation — find it
        if (e.code === '23505' || e.message?.includes('duplicate') || e.message?.includes('unique')) {
          conversation = await this.conversationRepo.findOne({
            where: { workspaceId, participantPhoneNumber: participantPhone, provider: ProviderType.WHATSAPP },
          });
          if (!conversation) {
            this.logger.warn(`[WhatsApp] Race condition but conversation still not found for ${participantPhone}`);
            return;
          }
        } else {
          throw e;
        }
      }
    } else {
      // Backfill tenant_id on existing untagged conversation (pre-fix data)
      if (resolvedTenantId && !conversation.tenantId) {
        conversation.tenantId = resolvedTenantId;
        await this.conversationRepo.save(conversation);
      }
      if (contactName) {
        const meta = (conversation.metadata as Record<string, unknown>) || {};
        if (!meta.contactName) {
          meta.contactName = contactName;
          conversation.metadata = meta;
          await this.conversationRepo.save(conversation);
        }
      }
    }

    // Create message record with original timestamp if provided
    const originalTimestamp = data.timestamp ? new Date(data.timestamp as string) : null;
    const msgProviderMessageId = externalMessageId || `wa_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    let message: any;
    try {
      message = this.messageRepo.create({
        conversationId: conversation.id,
        direction: isFromMe ? MessageDirection.OUT : MessageDirection.IN,
        channel: 'whatsapp' as any,
        body,
        fromNumber: normalizedFrom,
        toNumber: normalizedTo,
        providerMessageId: msgProviderMessageId,
        status: MessageStatus.DELIVERED,
        metadata: {
          externalChatId,
          hasMedia: data.hasMedia,
          type: data.type,
          ...(data.mediaStatus ? { mediaStatus: data.mediaStatus } : {}),
          ...(data.mediaSource ? { mediaSource: data.mediaSource } : {}),
          ...(data.mediaMimetype ? { mediaMimetype: data.mediaMimetype } : {}),
          ...(data.mediaFilename ? { mediaFilename: data.mediaFilename } : {}),
          ...(data.mediaSizeBytes ? { mediaSizeBytes: data.mediaSizeBytes } : {}),
        } as Record<string, unknown>,
      });
      await this.messageRepo.save(message);
    } catch (e: any) {
      // Race condition: message_create + message events fire simultaneously with same ID
      if (e.code === '23505' || e.message?.includes('duplicate') || e.message?.includes('unique')) {
        this.logger.debug(`[WhatsApp] Dedup (insert): message ${msgProviderMessageId} already exists`);
        return;
      }
      throw e;
    }

    // Save media to S3 if present. Falls back to local disk when S3 is not configured
    // (e.g. local dev without AWS creds) so we keep back-compat with the old pipeline.
    const mediaData = data.mediaData as string | undefined;
    const mediaMimetype = data.mediaMimetype as string | undefined;
    if (mediaData && mediaMimetype) {
      const meta = (message.metadata || {}) as Record<string, unknown>;
      try {
        const ext = this.mimeToExt(mediaMimetype);
        const buffer = Buffer.from(mediaData, 'base64');

        if (this.s3Service.isConfigured()) {
          const s3Key = this.s3Service.buildKey(workspaceId, message.id, ext);
          await this.s3Service.putObject({ key: s3Key, body: buffer, contentType: mediaMimetype });
          meta.mediaS3Key = s3Key;
          meta.mediaMimetype = mediaMimetype;
          meta.mediaSizeBytes = buffer.length;
          if (!meta.mediaStatus) meta.mediaStatus = 'downloaded';
          if (!meta.mediaSource) meta.mediaSource = data.mediaSource || 'realtime';
        } else {
          // Back-compat local disk path
          const mediaDir = path.join(process.cwd(), 'uploads', 'whatsapp', workspaceId);
          if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
          const filename = `${message.id}${ext}`;
          const filepath = path.join(mediaDir, filename);
          fs.writeFileSync(filepath, buffer);
          meta.mediaPath = `whatsapp/${workspaceId}/${filename}`;
          meta.mediaMimetype = mediaMimetype;
          meta.mediaSizeBytes = buffer.length;
        }
        message.metadata = meta;
        await this.messageRepo.save(message);
      } catch (e) {
        this.logger.debug(`[WhatsApp] Failed to save media: ${e instanceof Error ? e.message : 'unknown'}`);
        meta.mediaStatus = 'failed';
        message.metadata = meta;
        try { await this.messageRepo.save(message); } catch {}
      }
    }

    // Override createdAt with original message timestamp if available
    // Must use queryBuilder — repository.update() ignores @CreateDateColumn
    if (originalTimestamp && !isNaN(originalTimestamp.getTime()) && originalTimestamp.getFullYear() > 2020) {
      await this.messageRepo.createQueryBuilder()
        .update()
        .set({ createdAt: originalTimestamp } as any)
        .where('id = :id', { id: message.id })
        .execute();
      message.createdAt = originalTimestamp;
    }

    // Emit WebSocket event for real-time UI updates
    this.eventsGateway.emitNewMessage(workspaceId, {
      conversationId: conversation.id,
      message: {
        id: message.id,
        direction: message.direction,
        body: message.body,
        fromNumber: message.fromNumber,
        toNumber: message.toNumber,
        createdAt: message.createdAt,
        channel: 'whatsapp',
        provider: 'whatsapp',
      },
    });

    // Tag conversation with profile/business via the routing resolver, then
    // fan out additively across profile + business + tenant + workspace scopes.
    let resolvedScope: {
      tenantId?: string;
      businessId?: string;
      profileId?: string;
    } = { tenantId: resolvedTenantId || undefined };

    if (this.inboundResolver) {
      try {
        if (resolvedTenantId && !conversation.tenantId) {
          conversation.tenantId = resolvedTenantId;
        }
        const r = await this.inboundResolver.resolveAndApplyToConversation(conversation);
        resolvedScope = {
          tenantId: r.tenantId ?? resolvedTenantId ?? undefined,
          businessId: r.businessId ?? undefined,
          profileId: r.profileId ?? undefined,
        };
        if (r.profileId) {
          this.logger.log(
            `[whatsapp] resolved scope tenant=${r.tenantId?.slice(0, 8) ?? '-'} profile=${r.profileId.slice(0, 8)} business=${r.businessId?.slice(0, 8) ?? '-'} confidence=${r.confidence}`,
          );
        }
      } catch (err) {
        this.logger.error(`[whatsapp] inbound resolver failed: ${(err as Error).message}`);
      }
    }

    await this.outboundWebhooksService.emitEvent(
      workspaceId,
      WebhookEventType.WHATSAPP_MESSAGE_INBOUND,
      {
        provider: 'whatsapp',
        tenantId: resolvedScope.tenantId,
        communicationBusinessId: resolvedScope.businessId,
        communicationProfileId: resolvedScope.profileId,
        conversation: {
          id: conversation.id,
          externalChatId,
          participantPhone,
          endpointPhone: ownPhone,
          contactName,
        },
        message: {
          id: message.id,
          externalMessageId,
          text: body,
          body,
          fromNumber: normalizedFrom,
          toNumber: normalizedTo,
          fromMe: isFromMe,
          direction: isFromMe ? 'out' : 'in',
          timestamp: data.timestamp || new Date().toISOString(),
          hasMedia: data.hasMedia || false,
          type: data.type || 'chat',
          contactName,
        },
      },
      resolvedScope,
    );
  }

  private async handleWhatsAppMessageAck(
    workspaceId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const externalMessageId = data.externalMessageId as string;
    const status = data.status as string;

    if (!externalMessageId) return;

    // Find the message by provider message ID
    const message = await this.messageRepo.findOne({
      where: { providerMessageId: externalMessageId },
    });

    if (message) {
      const newStatus = status === 'delivered' ? MessageStatus.DELIVERED
        : status === 'read' ? MessageStatus.DELIVERED
        : message.status;

      if (newStatus !== message.status) {
        message.status = newStatus;
        await this.messageRepo.save(message);
      }

      await this.outboundWebhooksService.emitEvent(
        workspaceId,
        WebhookEventType.WHATSAPP_MESSAGE_DELIVERED,
        { provider: 'whatsapp', messageId: message.id, externalMessageId, status },
      );
    }
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
