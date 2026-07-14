import { Injectable, Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { validateRequest } from 'twilio';
import * as twilio from 'twilio';
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
import { Tenant } from '../../database/entities/tenant.entity';
import { CallConnectSettings } from '../../database/entities/call-connect-settings.entity';
import { EncryptionService } from '../../common/services/encryption.service';
import { EventsGateway } from '../events/events.gateway';
import { IdempotencyService } from './idempotency.service';
import {
  TenantVoiceForwarderService,
  ForwardInput,
} from './tenant-voice-forwarder.service';
import { TenantWebhooksService } from './tenant-webhooks.service';
import { OutboundWebhooksService } from './outbound-webhooks.service';
import { WebhookEventType } from '../../database/entities/webhook-subscription.entity';
import { CallConnectService } from './call-connect.service';
import { ResolveProfileForInboundService } from '../routing/resolve-profile-for-inbound.service';

export interface TwilioSmsWebhookPayload {
  MessageSid: string;
  AccountSid: string;
  MessagingServiceSid?: string;
  From: string;
  To: string;
  Body: string;
  NumMedia: string;
  NumSegments: string;
  SmsStatus?: string;
  ApiVersion?: string;
  FromCity?: string;
  FromState?: string;
  FromZip?: string;
  FromCountry?: string;
  ToCity?: string;
  ToState?: string;
  ToZip?: string;
  ToCountry?: string;
}

export interface TwilioSmsStatusPayload {
  MessageSid: string;
  MessageStatus: string;
  AccountSid: string;
  From: string;
  To: string;
  ErrorCode?: string;
  ErrorMessage?: string;
}

export interface TwilioVoiceWebhookPayload {
  CallSid: string;
  AccountSid: string;
  From: string;
  To: string;
  CallStatus: string;
  Direction: string;
  ApiVersion?: string;
  Caller?: string;
  Called?: string;
  CallerCity?: string;
  CallerState?: string;
  CallerZip?: string;
  CallerCountry?: string;
  CalledCity?: string;
  CalledState?: string;
  CalledZip?: string;
  CalledCountry?: string;
}

export interface TwilioCallStatusPayload {
  CallSid: string;
  CallStatus: string;
  AccountSid: string;
  From: string;
  To: string;
  Direction: string;
  CallDuration?: string;
  RecordingUrl?: string;
  RecordingSid?: string;
  RecordingDuration?: string;
}

export interface TwilioRecordingPayload {
  CallSid: string;
  RecordingSid: string;
  RecordingUrl: string;
  RecordingDuration: string;
  RecordingStatus: string;
  TranscriptionText?: string;
  TranscriptionStatus?: string;
  TranscriptionSid?: string;
}

@Injectable()
export class TwilioWebhooksService {
  private readonly logger = new Logger(TwilioWebhooksService.name);

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
    @InjectRepository(Tenant)
    private tenantRepo: Repository<Tenant>,
    @InjectRepository(CallConnectSettings)
    private ccSettingsRepo: Repository<CallConnectSettings>,
    private encryptionService: EncryptionService,
    private eventsGateway: EventsGateway,
    private configService: ConfigService,
    private idempotencyService: IdempotencyService,
    @Optional()
    @Inject(forwardRef(() => TenantWebhooksService))
    private tenantWebhooksService?: TenantWebhooksService,
    @Optional()
    @Inject(forwardRef(() => OutboundWebhooksService))
    private outboundWebhooksService?: OutboundWebhooksService,
    @Optional()
    private callConnectService?: CallConnectService,
    @Optional()
    private inboundResolver?: ResolveProfileForInboundService,
    // Wave-2 Voice Foundation PR 3 — optional so unit specs that construct
    // this service directly don't have to build a full forwarder. When
    // undefined the new step [3a] is skipped and behaviour is byte-identical
    // to pre-PR-3.
    @Optional()
    private voiceForwarder?: TenantVoiceForwarderService,
  ) {}

  /**
   * Resolve workspaceId from a Twilio phone number.
   * Two-step resolution via business-identity model, with fallback to legacy lookup.
   */
  async getWorkspaceIdByPhoneNumber(phoneNumber: string): Promise<string | null> {
    // Step 1: Try business-identity resolution (asset → candidates → best match)
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
        this.tenantRepo.manager.getRepository(Business),
        this.tenantRepo.manager.getRepository(ProductWorkspace),
        this.tenantRepo.manager.getRepository(SharedCommunicationAsset),
        this.tenantRepo.manager.getRepository(WorkspaceAssetLink),
        this.tenantRepo.manager.getRepository(EndpointRoute),
      );
      const identityService = new IdentityResolutionService(
        this.tenantRepo.manager.getRepository(SharedCommunicationAsset),
        this.tenantRepo.manager.getRepository(WorkspaceAssetLink),
        biService,
      );
      const routingService = new RoutingSelectionService();

      const normalized = biService.normalizePhone(phoneNumber);
      const { candidates } = await identityService.resolve({
        asset_type: AssetType.PHONE,
        normalized_value: normalized,
        provider: 'twilio',
      });

      if (candidates.length > 0) {
        const { selected } = routingService.select(candidates, {
          channel: 'sms',
          provider: 'twilio',
        });

        if (selected) {
          // Map product_workspace back to Sigcore workspaceId
          // The external_workspace_id for sigcore-type workspaces IS the tenant ID
          // We need the workspace that the tenant belongs to
          const tenant = await this.tenantRepo.findOne({
            where: { id: selected.workspace.externalWorkspaceId },
          });
          if (tenant) {
            this.logger.log(
              `[Routing] Resolved ${phoneNumber} via business-identity: workspace=${tenant.workspaceId} (score=${selected.score})`,
            );
            return tenant.workspaceId;
          }
        }
      }
    } catch (e) {
      this.logger.debug(`[Routing] Business-identity resolution not available: ${e.message}`);
    }

    // Step 2: Fallback to legacy routing
    // Check CC settings — prefer workspaceId (explicit), fall back to businessId (legacy rows)
    const cc = await this.ccSettingsRepo.findOne({
      where: { botNumberE164: phoneNumber },
      order: { updatedAt: 'DESC' },
    });
    if (cc) {
      this.logger.debug(`[Routing] Fallback: CC settings for ${phoneNumber}`);
      return cc.workspaceId || cc.businessId;
    }
    // Fallback: tenant_phone_numbers
    const tpn = await this.tenantPhoneNumberRepo.findOne({ where: { phoneNumber } });
    if (tpn) {
      this.logger.debug(`[Routing] Fallback: tenant_phone_numbers for ${phoneNumber}`);
      return tpn.workspaceId;
    }
    return null;
  }

  async getWorkspaceByWebhookId(webhookId: string): Promise<Workspace | null> {
    // Primary: look up by the dedicated webhookId token (correct format).
    const byToken = await this.workspaceRepo.findOne({ where: { webhookId } });
    if (byToken) return byToken;
    // Fallback: some phone numbers were configured with the workspace's primary key (id)
    // instead of its webhookId token. Accept both so legacy numbers don't 404.
    return this.workspaceRepo.findOne({ where: { id: webhookId } });
  }

  /**
   * Verify Twilio webhook signature using HMAC-SHA1.
   */
  verifyTwilioSignature(
    authToken: string,
    signature: string,
    url: string,
    params: Record<string, string>,
  ): boolean {
    try {
      return validateRequest(authToken, signature, url, params);
    } catch (error) {
      this.logger.error('Failed to verify Twilio signature', error);
      return false;
    }
  }

  /**
   * Get the auth token for a workspace's Twilio integration.
   *
   * Incident 2026-07-14 Phase 4a — when `accountSid` is provided, use it as
   * the primary lookup key. This avoids the ambiguity that appears once a
   * workspace holds >1 Twilio integration row (e.g. LB workspace-scoped +
   * Callio tenant-scoped after Phase 4). Fall back to workspace-scoped
   * lookup for legacy callers that don't yet pass `accountSid`.
   */
  async getAuthToken(
    workspaceId: string,
    accountSid?: string,
  ): Promise<string | null> {
    const where = accountSid
      ? {
          workspaceId,
          provider: ProviderType.TWILIO,
          externalWorkspaceId: accountSid,
        }
      : { workspaceId, provider: ProviderType.TWILIO };
    const integration = await this.integrationRepo.findOne({ where });

    if (!integration?.credentialsEncrypted) {
      return null;
    }

    const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);
    const parsed = JSON.parse(credentials);
    return parsed.authToken;
  }

  /**
   * Task 6B.5C — verify a Twilio callback signature against whichever
   * subaccount the AccountSid in the payload identifies. Used by the
   * token-carrying callback routes (recording-status, call-status) so
   * Sigcore can attribute the callback to the correct subaccount before
   * forwarding to Callio. Returns false on any lookup or verify failure.
   */
  async verifyRecordingCallbackSignature(
    payload: { AccountSid?: string; [k: string]: string | undefined },
    signature: string | undefined,
    url: string,
  ): Promise<boolean> {
    if (!signature || !payload.AccountSid) return false;
    // Look up the integration row that owns this subaccount SID.
    // `external_workspace_id` is populated with the subaccount SID by the
    // Task 6B.5A subaccount provisioner.
    const integration = await this.integrationRepo.findOne({
      where: {
        externalWorkspaceId: payload.AccountSid,
        provider: ProviderType.TWILIO,
      },
    });
    if (!integration?.credentialsEncrypted) return false;
    try {
      const creds = JSON.parse(
        this.encryptionService.decrypt(integration.credentialsEncrypted),
      );
      if (!creds.authToken) return false;
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(payload)) {
        if (typeof v === 'string') params[k] = v;
      }
      return this.verifyTwilioSignature(
        creds.authToken as string,
        signature,
        url,
        params,
      );
    } catch (err) {
      this.logger.warn(
        `verifyRecordingCallbackSignature decode/verify failed for AccountSid=${payload.AccountSid}: ${(err as Error).message.slice(0, 200)}`,
      );
      return false;
    }
  }

  /**
   * Handle incoming SMS webhook from Twilio.
   */
  async handleIncomingSms(
    workspaceId: string,
    payload: TwilioSmsWebhookPayload,
  ): Promise<void> {
    this.logger.log(`Processing Twilio SMS webhook: MessageSid=${payload.MessageSid}, From=${payload.From}, To=${payload.To}`);

    // Check idempotency
    const isDuplicate = await this.idempotencyService.isDuplicate(
      'twilio',
      payload.MessageSid,
      {
        eventType: 'sms.received',
        workspaceId,
        payload: payload as unknown as Record<string, unknown>,
      },
    );
    if (isDuplicate) {
      this.logger.log(`Skipping duplicate Twilio SMS webhook: ${payload.MessageSid}`);
      return;
    }

    const participantNumber = payload.From;
    const ourNumber = payload.To;

    // Find or create conversation
    let conversation = await this.conversationRepo.findOne({
      where: {
        workspaceId,
        participantPhoneNumber: participantNumber,
        phoneNumber: ourNumber,
        provider: ProviderType.TWILIO,
      },
    });

    let isNewConversation = false;
    let contactName: string | undefined;

    if (!conversation) {
      // Create new conversation
      const externalId = `${ourNumber}:${participantNumber}`;
      this.logger.log(`Creating new Twilio conversation: ${externalId}`);

      conversation = this.conversationRepo.create({
        workspaceId,
        externalId,
        provider: ProviderType.TWILIO,
        phoneNumber: ourNumber,
        participantPhoneNumber: participantNumber,
        participantPhoneNumbers: [participantNumber],
        metadata: {},
      });

      // Contact linking now handled in Callio service

      await this.conversationRepo.save(conversation);
      isNewConversation = true;
    }

    // Check for duplicate message
    const existingMessage = await this.messageRepo
      .createQueryBuilder('msg')
      .innerJoin('msg.conversation', 'conv')
      .where('msg.providerMessageId = :providerId', { providerId: payload.MessageSid })
      .andWhere('conv.workspaceId = :workspaceId', { workspaceId })
      .getOne();

    if (existingMessage) {
      this.logger.log(`Message ${payload.MessageSid} already exists, skipping`);
      return;
    }

    // Create message record
    const message = this.messageRepo.create({
      conversationId: conversation.id,
      direction: MessageDirection.IN,
      body: payload.Body || '',
      fromNumber: payload.From,
      toNumber: payload.To,
      providerMessageId: payload.MessageSid,
      status: MessageStatus.DELIVERED,
      metadata: {
        numMedia: parseInt(payload.NumMedia || '0', 10),
        numSegments: parseInt(payload.NumSegments || '1', 10),
        fromCity: payload.FromCity,
        fromState: payload.FromState,
        fromCountry: payload.FromCountry,
      },
    });

    await this.messageRepo.save(message);
    this.logger.log(`Saved Twilio message ${payload.MessageSid} to conversation ${conversation.id}`);

    // Emit real-time events
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

    const metadata = conversation.metadata as Record<string, unknown> || {};
    if (isNewConversation) {
      this.eventsGateway.emitNewConversation(workspaceId, {
        id: conversation.id,
        externalId: conversation.externalId,
        phoneNumber: conversation.phoneNumber,
        phoneNumberName: null,
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

    // Tag the conversation with profile + business via the routing resolver
    // (sticky → phone-default → unknown), then emit the webhook with the
    // full scope so additive fan-out (profile + business + tenant + workspace)
    // can match all relevant subscriptions.
    let resolved: {
      tenantId: string | null;
      profileId: string | null;
      businessId: string | null;
    } = { tenantId: null, profileId: null, businessId: null };

    if (this.inboundResolver) {
      try {
        const r = await this.inboundResolver.resolveAndApplyToConversation(conversation);
        resolved = { tenantId: r.tenantId, profileId: r.profileId, businessId: r.businessId };
        if (r.tenantId) {
          this.logger.log(
            `[twilio] resolved scope tenant=${r.tenantId.slice(0, 8)} profile=${r.profileId?.slice(0, 8) ?? '-'} business=${r.businessId?.slice(0, 8) ?? '-'} confidence=${r.confidence}`,
          );
        }
      } catch (err) {
        this.logger.error(`[twilio] inbound resolver failed: ${(err as Error).message}`);
      }
    }

    // Fall back to the legacy tenant_phone_numbers lookup if the resolver
    // didn't produce a tenantId (e.g. resolver not injected in tests).
    if (!resolved.tenantId) {
      const tenantPhone = await this.tenantPhoneNumberRepo.findOne({
        where: { workspaceId, phoneNumber: ourNumber },
      });
      if (tenantPhone) {
        resolved.tenantId = tenantPhone.tenantId;
      }
    }

    // Emit outbound webhook with full scope for additive fan-out.
    if (this.outboundWebhooksService) {
      const convMeta = (conversation.metadata as Record<string, unknown>) || {};
      this.outboundWebhooksService
        .emitMessageEvent(
          workspaceId,
          WebhookEventType.MESSAGE_INBOUND,
          message,
          { conversationMetadata: convMeta },
          {
            tenantId: resolved.tenantId ?? undefined,
            businessId: resolved.businessId ?? undefined,
            profileId: resolved.profileId ?? undefined,
          },
        )
        .catch((err) => {
          this.logger.error(`Failed to emit inbound SMS webhook for message ${message.id}: ${err.message}`);
        });
    }
  }

  /**
   * Handle SMS status callback from Twilio.
   * Updates message status and forwards to tenant webhook if configured.
   */
  async handleSmsStatus(payload: TwilioSmsStatusPayload): Promise<void> {
    this.logger.log(`Processing Twilio SMS status: MessageSid=${payload.MessageSid}, Status=${payload.MessageStatus}`);

    const message = await this.messageRepo.findOne({
      where: { providerMessageId: payload.MessageSid },
      relations: ['conversation'],
    });

    if (!message) {
      this.logger.warn(`Message ${payload.MessageSid} not found for status update`);
      return;
    }

    message.status = this.mapMessageStatus(payload.MessageStatus);

    if (payload.ErrorCode || payload.ErrorMessage) {
      message.metadata = {
        ...message.metadata,
        errorCode: payload.ErrorCode,
        errorMessage: payload.ErrorMessage,
      };
    }

    await this.messageRepo.save(message);
    this.logger.log(`Updated message ${payload.MessageSid} status to ${message.status}`);

    // Forward status to tenant webhook (fire and forget)
    if (this.tenantWebhooksService) {
      this.tenantWebhooksService
        .forwardStatusToTenant(
          message,
          message.status,
          payload.ErrorCode,
          payload.ErrorMessage,
        )
        .catch((err) => {
          this.logger.error(`Failed to forward status to tenant: ${err.message}`);
        });
    }

    // Emit webhook event to subscriptions (fire and forget)
    // Resolve tenantId from the message's fromNumber (our number for outbound status updates)
    if (this.outboundWebhooksService && message.conversation) {
      // Twilio status callback statuses we fan out:
      //   delivered  → MESSAGE_DELIVERED
      //   failed/undelivered → MESSAGE_FAILED (mapMessageStatus collapses both)
      //   sent (carrier-handoff confirmation, pre-delivery) → MESSAGE_SENT
      // Statuses we don't fan out: PENDING (queued/sending — too noisy,
      // most subscribers don't care about pre-Twilio states).
      const eventType = message.status === MessageStatus.DELIVERED
        ? WebhookEventType.MESSAGE_DELIVERED
        : message.status === MessageStatus.FAILED
          ? WebhookEventType.MESSAGE_FAILED
          : message.status === MessageStatus.SENT
            ? WebhookEventType.MESSAGE_SENT
            : null;

      if (eventType) {
        let statusTenantId: string | undefined;
        const statusTenantPhone = await this.tenantPhoneNumberRepo.findOne({
          where: { workspaceId: message.conversation.workspaceId, phoneNumber: message.fromNumber },
        });
        if (statusTenantPhone) {
          statusTenantId = statusTenantPhone.tenantId;
        }
        this.outboundWebhooksService
          .emitMessageEvent(
            message.conversation.workspaceId,
            eventType,
            message,
            {
              errorCode: payload.ErrorCode,
              errorMessage: payload.ErrorMessage,
            },
            statusTenantId,
          )
          .catch((err) => {
            this.logger.error(`Failed to emit webhook event: ${err.message}`);
          });
      }
    }
  }

  /**
   * Handle incoming voice call webhook from Twilio.
   * Returns TwiML response for call handling.
   */
  async handleIncomingCall(
    workspaceId: string,
    payload: TwilioVoiceWebhookPayload,
    forwardCtx?: {
      rawBody: Buffer | string;
      contentType: string;
      twilioSignature: string | undefined;
      forwardedHeaders: Record<string, string>;
    },
  ): Promise<string> {
    this.logger.log(`Processing Twilio voice webhook: CallSid=${payload.CallSid}, From=${payload.From}, To=${payload.To}`);

    const participantNumber = payload.From;
    const ourNumber = payload.To;

    // Find or create conversation
    let conversation = await this.conversationRepo.findOne({
      where: {
        workspaceId,
        participantPhoneNumber: participantNumber,
        provider: ProviderType.TWILIO,
      },
    });

    let isNewConversation = false;
    let contactName: string | undefined;

    if (!conversation) {
      const externalId = `${ourNumber}:${participantNumber}`;
      conversation = this.conversationRepo.create({
        workspaceId,
        externalId,
        provider: ProviderType.TWILIO,
        phoneNumber: ourNumber,
        participantPhoneNumber: participantNumber,
        participantPhoneNumbers: [participantNumber],
        metadata: {},
      });

      // Contact linking now handled in Callio service

      await this.conversationRepo.save(conversation);
      isNewConversation = true;
    }

    // Resolve the workspace's Twilio integration id so downstream calls to
    // `IntegrationResourceGuard` (Callio's Task-6B hangup / recording_start ops)
    // hit the strict `metadata.integrationId === integrationId` link instead of
    // the pilot AccountSid-prefix fallback. Best-effort — a missing integration
    // row simply omits the field and preserves the pre-Phase-B fallback path.
    const inboundIntegration = await this.integrationRepo.findOne({
      where: { workspaceId, provider: 'twilio' as any },
    });

    // Create call record
    const call = this.callRepo.create({
      conversationId: conversation.id,
      direction: CallDirection.IN,
      duration: 0,
      fromNumber: payload.From,
      toNumber: payload.To,
      providerCallId: payload.CallSid,
      status: CallStatus.COMPLETED, // Will be updated on completion
      metadata: {
        status: payload.CallStatus,
        callerCity: payload.CallerCity,
        callerState: payload.CallerState,
        callerCountry: payload.CallerCountry,
        ...(inboundIntegration ? { integrationId: inboundIntegration.id } : {}),
      },
    });

    await this.callRepo.save(call);
    this.logger.log(
      `Created Twilio call record ${payload.CallSid} (integrationId=${inboundIntegration?.id ?? 'null'})`,
    );

    // Emit call.inbound webhook so LeadBridge can match caller to lead
    if (this.outboundWebhooksService) {
      this.outboundWebhooksService
        .emitEvent(workspaceId, WebhookEventType.CALL_INBOUND, {
          callId: call.id,
          conversationId: conversation.id,
          callSid: payload.CallSid,
          fromNumber: participantNumber,
          toNumber: ourNumber,
          direction: 'inbound',
        })
        .catch((err) => {
          this.logger.error(`Failed to emit call.inbound webhook: ${err.message}`);
        });
    }

    // Emit real-time event
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

    if (isNewConversation) {
      this.eventsGateway.emitNewConversation(workspaceId, {
        id: conversation.id,
        externalId: conversation.externalId,
        phoneNumber: conversation.phoneNumber,
        phoneNumberName: null,
        participantPhoneNumber: conversation.participantPhoneNumber,
        contactId: conversation.contactId,
        contactName,
        lastMessage: null,
        lastMessageAt: null,
        unreadCount: 0,
      });
    }

    // ── ROUTING DECISION TRACE ──────────────────────────────────────────────
    this.logger.log(`[ROUTING] CallSid=${payload.CallSid} ourNumber=${ourNumber} workspaceId=${workspaceId}`);

    // Check if a Call Connect configuration exists for this bot number (any state).
    // CC settings are authoritative: they map botNumberE164 → agentPhoneE164 and are
    // stored per-business (not per-workspace), so they survive tenant re-provisioning
    // without requiring any cross-workspace lookup.
    // IMPORTANT: if CC settings EXIST for this number (even disabled), we NEVER fall
    // through to the legacy callForwardingNumber path — doing so would send calls to an
    // unintended BYO phone. Only fully-configured + enabled settings get forwarded;
    // everything else goes to voicemail.
    // When multiple CC settings share the same botNumber (e.g., per-account
    // isolation created new rows while legacy rows remain), prefer the most
    // recently updated row — it has the freshest agent phone number.
    const ccSettings = await this.ccSettingsRepo.findOne({
      where: { botNumberE164: ourNumber },
      order: { updatedAt: 'DESC' },
    });
    this.logger.log(
      `[ROUTING] CC settings lookup for botNumberE164=${ourNumber}: ` +
      (ccSettings
        ? `FOUND businessId=${ccSettings.businessId} enabled=${ccSettings.enabled} agentPhoneE164=${ccSettings.agentPhoneE164 ?? 'null'}`
        : 'NOT FOUND'),
    );
    if (ccSettings) {
      if (ccSettings.enabled && ccSettings.agentPhoneE164) {
        // Ownership audit log only — CC settings are the authoritative source (they are
        // written per-businessId and survive tenant re-provisioning). Do not block here:
        // tenant_phone_numbers.tenantId can be stale after re-provisioning epochs, and
        // blocking on it would prevent forwarding to the correct agent number.
        const ownerAllocation = await this.tenantPhoneNumberRepo.findOne({
          where: { workspaceId, phoneNumber: ourNumber, tenantId: ccSettings.businessId },
        });
        if (!ownerAllocation) {
          this.logger.warn(
            `[ROUTING] Ownership audit: ${ourNumber} not in tenant_phone_numbers for businessId=${ccSettings.businessId} (stale allocation — proceeding with CC settings)`,
          );
        }
        this.logger.log(
          `[ROUTING] → CC path: forwarding to agentPhoneE164=${ccSettings.agentPhoneE164} (businessId=${ccSettings.businessId})`,
        );
        return this.generateForwardTwiML(ccSettings.agentPhoneE164, ourNumber);
      }
      // CC settings exist but not actionable — do NOT fall through to legacy forwarding.
      this.logger.log(
        `[ROUTING] → CC settings exist but not actionable ` +
        `(enabled=${ccSettings.enabled}, agentPhone=${ccSettings.agentPhoneE164 ?? 'null'}) — returning voicemail`,
      );
      return this.generateVoicemailTwiML();
    }

    // No CC settings for this number — use legacy tenant metadata forwarding.
    const phoneAllocation = await this.tenantPhoneNumberRepo.findOne({
      where: { workspaceId, phoneNumber: ourNumber },
    });
    this.logger.log(
      `[ROUTING] phoneAllocation for workspaceId=${workspaceId} phoneNumber=${ourNumber}: ` +
      (phoneAllocation ? `FOUND tenantId=${phoneAllocation.tenantId}` : 'NOT FOUND'),
    );
    if (phoneAllocation) {
      const tenant = await this.tenantRepo.findOne({ where: { id: phoneAllocation.tenantId } });
      const forwardTo = tenant?.metadata?.callForwardingNumber as string | undefined;
      this.logger.log(
        `[ROUTING] tenant metadata for tenantId=${phoneAllocation.tenantId}: ` +
        `callForwardingNumber=${forwardTo ?? 'null'} fullMetadata=${JSON.stringify(tenant?.metadata ?? {})}`,
      );
      if (forwardTo) {
        this.logger.log(`[ROUTING] → Legacy path: forwarding to callForwardingNumber=${forwardTo} (tenantId=${tenant!.id})`);
        return this.generateForwardTwiML(forwardTo, ourNumber);
      }

      // ── Wave-2 Voice Foundation PR 3 — step [3a] tenant voice forwarding.
      //
      // Insertion point: after CallConnect (line 704) and legacy metadata
      // forwarding (line 731), before voicemail fallback. Preserves both
      // pre-existing forwarding paths — they still terminate before we get
      // here. Voicemail below is the fallback of last resort.
      //
      // Gates (ALL must be true, else skip and voicemail):
      //   * SIGCORE_VOICE_INBOUND_FORWARD_ENABLED === 'true'
      //   * TenantVoiceForwarderService is injected (module-level wiring)
      //   * The forwarder input context (rawBody + headers) was passed in
      //   * The tenant has voice_inbound_url set (persisted by PR 2 API)
      //
      // On success: return the tenant's TwiML byte-for-byte. Sigcore does
      // not rewrite, re-encode, or generate TwiML in this path.
      //
      // On any failure (definite 4xx OR ambiguous 5xx/timeout/DNS/TLS/etc):
      // fall through to voicemail below. The forwarder handles alerting.
      const forwardFlag =
        (this.configService.get<string>('SIGCORE_VOICE_INBOUND_FORWARD_ENABLED') ??
          '').toLowerCase() === 'true';
      if (
        forwardFlag &&
        this.voiceForwarder &&
        forwardCtx &&
        tenant?.voiceInboundUrl
      ) {
        const forwardInput: ForwardInput = {
          voiceInboundUrl: tenant.voiceInboundUrl,
          rawBody: forwardCtx.rawBody,
          contentType: forwardCtx.contentType,
          twilioSignature: forwardCtx.twilioSignature,
          forwardedHeaders: forwardCtx.forwardedHeaders,
          correlation: {
            workspaceId,
            tenantId: tenant.id,
            providerCallSid: payload.CallSid,
            environment:
              this.configService.get<string>('RAILWAY_ENVIRONMENT_NAME') ??
              this.configService.get<string>('NODE_ENV') ??
              'unknown',
          },
        };
        const result = await this.voiceForwarder.forward(forwardInput);
        if (result.outcome === 'success') {
          return result.twiml;
        }
        // Any failure — flow to voicemail. Forwarder already logged +
        // alerted; nothing more to do here.
      }
    }
    this.logger.log(`[ROUTING] → No forwarding configured — returning voicemail`);
    return this.generateVoicemailTwiML();
  }

  /**
   * Handle outgoing call from browser (Voice SDK).
   * Creates call record and returns TwiML to dial the destination number.
   */
  async handleOutgoingCall(
    workspaceId: string,
    payload: TwilioVoiceWebhookPayload,
  ): Promise<string> {
    this.logger.log(`========== HANDLE OUTGOING CALL START ==========`);
    this.logger.log(`Workspace ID: ${workspaceId}`);
    this.logger.log(`Full payload: ${JSON.stringify(payload, null, 2)}`);

    // Get the destination number from the payload
    const toNumber = payload.To;
    const fromNumber = payload.From; // This is the workspace phone number passed from the frontend
    const participantNumber = toNumber;
    const ourNumber = fromNumber;

    this.logger.log(`Extracted - To: ${toNumber}, From: ${fromNumber}`);

    // Find or create conversation
    let conversation = await this.conversationRepo.findOne({
      where: {
        workspaceId,
        participantPhoneNumber: participantNumber,
        provider: ProviderType.TWILIO,
      },
    });

    if (!conversation) {
      const externalId = `${ourNumber}:${participantNumber}`;
      conversation = this.conversationRepo.create({
        workspaceId,
        externalId,
        provider: ProviderType.TWILIO,
        phoneNumber: ourNumber,
        participantPhoneNumber: participantNumber,
        participantPhoneNumbers: [participantNumber],
        metadata: {},
      });

      // Contact linking now handled in Callio service

      await this.conversationRepo.save(conversation);
      this.logger.log(`Created conversation ${conversation.id} for outgoing call`);
    }

    // Create call record
    const call = this.callRepo.create({
      conversationId: conversation.id,
      direction: CallDirection.OUT,
      duration: 0,
      fromNumber: payload.From,
      toNumber: payload.To,
      providerCallId: payload.CallSid,
      status: CallStatus.COMPLETED, // Will be updated via status callback
      startedAt: new Date(),
      metadata: {
        status: payload.CallStatus,
      },
    });

    await this.callRepo.save(call);
    this.logger.log(`Created outgoing call record ${payload.CallSid}`);

    // Emit real-time event
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

    // Generate TwiML to dial the destination number
    this.logger.log(`Creating TwiML VoiceResponse...`);
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();

    this.logger.log(`Adding Dial verb with callerId=${fromNumber}, answerOnBridge=true, record=record-from-answer-dual`);
    const dial = response.dial({
      callerId: fromNumber,
      answerOnBridge: true,
      record: 'record-from-answer-dual',
      recordingStatusCallback: `${this.configService.get<string>('BASE_URL')}/api/webhooks/twilio/recording-status`,
    });

    this.logger.log(`Adding Number noun: ${toNumber}`);
    dial.number(toNumber);

    const twimlString = response.toString();
    this.logger.log(`Generated TwiML string:`);
    this.logger.log(twimlString);
    this.logger.log(`========== HANDLE OUTGOING CALL END ==========`);

    return twimlString;
  }

  /**
   * Handle call status callback from Twilio.
   */
  async handleCallStatus(payload: TwilioCallStatusPayload): Promise<void> {
    this.logger.log(`Processing Twilio call status: CallSid=${payload.CallSid}, Status=${payload.CallStatus}`);

    // Forward to Call Connect state machine first (handles CC session calls
    // that are not stored in communication_calls)
    if (this.callConnectService) {
      this.callConnectService
        .handleProviderCallStatus(payload.CallSid, payload.CallStatus, payload.CallDuration)
        .catch((err) => {
          this.logger.error(`Call Connect status handler error: ${err.message}`);
        });
    }

    const call = await this.callRepo.findOne({
      where: { providerCallId: payload.CallSid },
    });

    if (!call) {
      this.logger.warn(`Call ${payload.CallSid} not found in communication_calls — may be a Call Connect leg`);
      return;
    }

    call.status = this.mapCallStatus(payload.CallStatus);
    call.duration = parseInt(payload.CallDuration || '0', 10);

    if (payload.RecordingUrl) {
      call.recordingUrl = payload.RecordingUrl;
      call.voicemailUrl = payload.RecordingUrl; // Treat as voicemail
    }

    call.endedAt = new Date();
    call.metadata = {
      ...call.metadata,
      finalStatus: payload.CallStatus,
      recordingSid: payload.RecordingSid,
      recordingDuration: payload.RecordingDuration,
    };

    await this.callRepo.save(call);
    this.logger.log(`Updated call ${payload.CallSid} status to ${call.status}, duration=${call.duration}s`);
  }

  /**
   * Phase B.1 — forward a call-status callback to the tenant's Callio
   * status endpoint under a Sigcore HMAC envelope. Called by the scoped
   * status callback controller AFTER Twilio signature verification and
   * AFTER local `handleCallStatus` state update.
   *
   * Failure modes are all treated as fallback (Sigcore-side state is
   * already updated). Callio-side state may be stale; a follow-up call
   * status event or the recording-status callback will resync.
   */
  async forwardCallStatusToCallio(
    workspaceId: string,
    payload: TwilioCallStatusPayload,
    req: {
      rawBody?: Buffer;
      headers?: Record<string, string | string[] | undefined>;
    },
    twilioSignature: string,
  ): Promise<{ outcome: 'success' | 'skipped' | 'fallback'; reason?: string }> {
    if (!this.voiceForwarder) {
      return { outcome: 'skipped', reason: 'forwarder_not_wired' };
    }
    const forwardFlag =
      (this.configService.get<string>('SIGCORE_VOICE_INBOUND_FORWARD_ENABLED') ??
        '').toLowerCase() === 'true';
    if (!forwardFlag) {
      return { outcome: 'skipped', reason: 'flag_off' };
    }

    // Resolve the tenant that owns the destination number on this call.
    // Twilio uses `Called` for outbound, `To` for inbound number-level
    // status_callbacks. Try both — first non-empty wins.
    const ourNumber = payload.To || (payload as any).Called;
    if (!ourNumber) {
      return { outcome: 'skipped', reason: 'no_destination_number' };
    }
    const phoneAllocation = await this.tenantPhoneNumberRepo.findOne({
      where: { workspaceId, phoneNumber: ourNumber },
    });
    if (!phoneAllocation) {
      return { outcome: 'skipped', reason: 'no_tenant_binding' };
    }
    const tenant = await this.tenantRepo.findOne({ where: { id: phoneAllocation.tenantId } });
    const voiceInboundUrl = tenant?.voiceInboundUrl;
    if (!voiceInboundUrl) {
      return { outcome: 'skipped', reason: 'no_voice_inbound_url' };
    }

    // Derive the Callio status URL by swapping `/voice/` for `/status/`.
    // Callio's TwilioStatusController is `@Controller('webhooks/twilio/status')`
    // + `@Post(':workspaceId')` — same workspaceId path segment as the
    // inbound-voice route. If a tenant sets a bespoke voiceInboundUrl that
    // doesn't contain `/voice/`, we skip forwarding rather than guess.
    if (!voiceInboundUrl.includes('/webhooks/twilio/voice/')) {
      return { outcome: 'skipped', reason: 'voice_url_shape_unrecognized' };
    }
    const callioStatusUrl = voiceInboundUrl.replace(
      '/webhooks/twilio/voice/',
      '/webhooks/twilio/status/',
    );

    // Lazy import to avoid a heavier module cycle — CallbackForwarderService
    // is already exported by the webhooks module.
    const {
      CallbackForwarderService,
    } = await import('./callback-forwarder.service');
    const forwarder = new CallbackForwarderService(this.configService);
    if (!forwarder.isArmed()) {
      return { outcome: 'skipped', reason: 'callback_forwarder_not_armed' };
    }

    const rawBody =
      req.rawBody && req.rawBody.length > 0
        ? req.rawBody
        : Buffer.from(
            new URLSearchParams(payload as unknown as Record<string, string>).toString(),
            'utf8',
          );
    const contentType =
      typeof req.headers?.['content-type'] === 'string'
        ? (req.headers['content-type'] as string)
        : 'application/x-www-form-urlencoded';

    const result = await forwarder.forward({
      eventType: 'voice_call_status',
      callioDestUrl: callioStatusUrl,
      sigcoreWorkspaceId: workspaceId,
      sigcoreTenantId: tenant!.id,
      providerCallSid: payload.CallSid,
      rawBody,
      contentType,
      twilioSignature,
    });
    if (result.outcome === 'success') {
      return { outcome: 'success' };
    }
    return {
      outcome: 'fallback',
      reason: `${result.reason ?? 'forward_failed'}${result.statusCode ? `:${result.statusCode}` : ''}`,
    };
  }

  /**
   * Handle recording completion webhook from Twilio.
   */
  async handleRecordingComplete(payload: TwilioRecordingPayload): Promise<void> {
    this.logger.log(`Processing Twilio recording: CallSid=${payload.CallSid}, RecordingSid=${payload.RecordingSid}`);

    // Propagate to any Call Connect session that owns this CallSid FIRST. CC agent/lead
    // legs are not stored in communication_calls, so the callRepo lookup below returns
    // null for them — we still need to persist recordingUrl on CallConnectSession and
    // re-emit call_connect.ended to LB so LeadCallConnect.recordingUrl gets set.
    if (this.callConnectService) {
      this.callConnectService
        .attachRecordingToSession(payload.CallSid, payload.RecordingUrl)
        .catch((err) => {
          this.logger.warn(
            `[handleRecordingComplete] attachRecordingToSession failed for CallSid ${payload.CallSid}: ${err.message}`,
          );
        });
    }

    const call = await this.callRepo.findOne({
      where: { providerCallId: payload.CallSid },
      relations: ['conversation'],
    });

    if (!call) {
      this.logger.warn(`Call ${payload.CallSid} not found in communication_calls — may be a Call Connect leg`);
      return;
    }

    call.recordingUrl = payload.RecordingUrl;
    call.voicemailUrl = payload.RecordingUrl;

    if (payload.TranscriptionText) {
      call.transcript = payload.TranscriptionText;
      call.transcriptStatus = payload.TranscriptionStatus || 'completed';
    }

    call.metadata = {
      ...call.metadata,
      recordingSid: payload.RecordingSid,
      recordingDuration: parseInt(payload.RecordingDuration || '0', 10),
      recordingStatus: payload.RecordingStatus,
      transcriptionSid: payload.TranscriptionSid,
    };

    await this.callRepo.save(call);
    this.logger.log(`Updated call ${payload.CallSid} with recording URL`);

    // Emit real-time event for frontend to auto-refresh
    if (call.conversation) {
      this.eventsGateway.emitCallUpdate(call.conversation.workspaceId, call);
      this.logger.log(`Emitted call update event for workspace ${call.conversation.workspaceId}`);
    }
  }

  /**
   * Generate TwiML for voicemail response.
   */
  generateVoicemailTwiML(greeting?: string): string {
    const response = new twilio.twiml.VoiceResponse();

    response.say(
      greeting || 'Hello, we are unable to take your call right now. Please leave a message after the tone.',
    );

    response.record({
      maxLength: 120,
      transcribe: true,
      playBeep: true,
      action: '/api/webhooks/twilio/recording-status',
      timeout: 10,
    });

    response.say('We did not receive a recording. Goodbye.');

    return response.toString();
  }

  /**
   * Generate TwiML for call forwarding.
   * Uses an action URL so we get notified of the dial outcome (answered/no-answer/busy).
   */
  generateForwardTwiML(forwardToNumber: string, callerId?: string): string {
    const baseUrl = this.getBaseUrl();
    const response = new twilio.twiml.VoiceResponse();

    response.say('Please hold while we connect your call.');

    const dial = response.dial({
      timeout: 30,
      ...(callerId && { callerId }),
      action: `${baseUrl}/api/webhooks/twilio/voice/forward-status`,
      method: 'POST',
    });
    dial.number(forwardToNumber);

    return response.toString();
  }

  /**
   * Handle the outcome of a forwarded inbound call (<Dial> action callback).
   * Emits call.completed or call.missed webhook, returns voicemail TwiML on no-answer.
   */
  async handleForwardDialStatus(
    workspaceId: string,
    payload: Record<string, string>,
  ): Promise<string> {
    const dialStatus = payload.DialCallStatus; // completed, no-answer, busy, failed, canceled
    const callSid = payload.CallSid;
    const fromNumber = payload.From;
    const toNumber = payload.To;

    this.logger.log(
      `[FORWARD] Dial status for CallSid=${callSid}: DialCallStatus=${dialStatus}, From=${fromNumber}, To=${toNumber}`,
    );

    // Emit webhook so LeadBridge can react (e.g. send missed-call SMS)
    if (this.outboundWebhooksService) {
      const eventType = dialStatus === 'completed'
        ? WebhookEventType.CALL_COMPLETED
        : WebhookEventType.CALL_MISSED;
      this.outboundWebhooksService
        .emitEvent(workspaceId, eventType, {
          callSid,
          fromNumber,
          toNumber,
          dialCallStatus: dialStatus,
          dialCallDuration: payload.DialCallDuration,
        })
        .catch((err) => {
          this.logger.error(`Failed to emit ${eventType} webhook: ${err.message}`);
        });
    }

    // If agent answered and call completed normally, just hang up
    if (dialStatus === 'completed') {
      const response = new twilio.twiml.VoiceResponse();
      response.hangup();
      return response.toString();
    }

    // Agent didn't answer — play voicemail
    return this.generateVoicemailTwiML();
  }

  private getBaseUrl(): string {
    const configured = this.configService.get<string>('BASE_URL');
    if (configured) return configured.replace(/\/$/, '');
    const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
    if (railwayDomain) return `https://${railwayDomain}`;
    return 'http://localhost:3002';
  }

  private mapMessageStatus(status: string): MessageStatus {
    const statusMap: Record<string, MessageStatus> = {
      queued: MessageStatus.PENDING,
      sending: MessageStatus.PENDING,
      sent: MessageStatus.SENT,
      delivered: MessageStatus.DELIVERED,
      undelivered: MessageStatus.FAILED,
      failed: MessageStatus.FAILED,
      received: MessageStatus.DELIVERED,
    };
    return statusMap[status] || MessageStatus.PENDING;
  }

  private mapCallStatus(status: string): CallStatus {
    const statusMap: Record<string, CallStatus> = {
      completed: CallStatus.COMPLETED,
      busy: CallStatus.MISSED,
      'no-answer': CallStatus.MISSED,
      canceled: CallStatus.CANCELLED,
      failed: CallStatus.MISSED,
    };
    return statusMap[status] || CallStatus.COMPLETED;
  }

}
