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
import { EncryptionService } from '../../common/services/encryption.service';
import { EventsGateway } from '../events/events.gateway';
import { IdempotencyService } from './idempotency.service';
import { TenantWebhooksService } from './tenant-webhooks.service';
import { OutboundWebhooksService } from './outbound-webhooks.service';
import { WebhookEventType } from '../../database/entities/webhook-subscription.entity';
import { CallConnectService } from './call-connect.service';

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
  ) {}

  async getWorkspaceByWebhookId(webhookId: string): Promise<Workspace | null> {
    return this.workspaceRepo.findOne({
      where: { webhookId },
    });
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
   */
  async getAuthToken(workspaceId: string): Promise<string | null> {
    const integration = await this.integrationRepo.findOne({
      where: { workspaceId, provider: ProviderType.TWILIO },
    });

    if (!integration?.credentialsEncrypted) {
      return null;
    }

    const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);
    const parsed = JSON.parse(credentials);
    return parsed.authToken;
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
    if (this.outboundWebhooksService && message.conversation) {
      const eventType = message.status === MessageStatus.DELIVERED
        ? WebhookEventType.MESSAGE_DELIVERED
        : message.status === MessageStatus.FAILED
          ? WebhookEventType.MESSAGE_FAILED
          : null;

      if (eventType) {
        this.outboundWebhooksService
          .emitMessageEvent(
            message.conversation.workspaceId,
            eventType,
            message,
            {
              errorCode: payload.ErrorCode,
              errorMessage: payload.ErrorMessage,
            },
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
      },
    });

    await this.callRepo.save(call);
    this.logger.log(`Created Twilio call record ${payload.CallSid}`);

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

    // Check if there is a call forwarding number configured for this phone.
    const phoneAllocation = await this.tenantPhoneNumberRepo.findOne({
      where: { workspaceId, phoneNumber: ourNumber },
    });
    if (phoneAllocation) {
      // Allocation-level metadata is authoritative — set by LeadBridge and survives
      // tenant re-provisioning where the owning tenantId may have changed.
      const allocationForward = phoneAllocation.metadata?.callForwardingNumber as string | undefined;
      if (allocationForward) {
        this.logger.log(`Forwarding incoming call to ${allocationForward} (allocation metadata for ${ourNumber})`);
        return this.generateForwardTwiML(allocationForward);
      }
      // Fall back to the owning tenant's metadata (legacy / non-LeadBridge setups).
      const tenant = await this.tenantRepo.findOne({ where: { id: phoneAllocation.tenantId } });
      const forwardTo = tenant?.metadata?.callForwardingNumber as string | undefined;
      if (forwardTo) {
        this.logger.log(`Forwarding incoming call to ${forwardTo} (tenant: ${tenant!.id})`);
        return this.generateForwardTwiML(forwardTo);
      }
    }
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
   * Handle recording completion webhook from Twilio.
   */
  async handleRecordingComplete(payload: TwilioRecordingPayload): Promise<void> {
    this.logger.log(`Processing Twilio recording: CallSid=${payload.CallSid}, RecordingSid=${payload.RecordingSid}`);

    const call = await this.callRepo.findOne({
      where: { providerCallId: payload.CallSid },
      relations: ['conversation'],
    });

    if (!call) {
      this.logger.warn(`Call ${payload.CallSid} not found for recording update`);
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
      action: '/api/webhooks/twilio/recording-complete',
      timeout: 10,
    });

    response.say('We did not receive a recording. Goodbye.');

    return response.toString();
  }

  /**
   * Generate TwiML for call forwarding.
   */
  generateForwardTwiML(forwardToNumber: string): string {
    const response = new twilio.twiml.VoiceResponse();

    response.say('Please hold while we connect your call.');

    const dial = response.dial({
      timeout: 30,
      action: '/api/webhooks/twilio/call-status',
    });
    dial.number(forwardToNumber);

    // Fallback to voicemail if no answer
    response.say('The person you are trying to reach is unavailable. Please leave a message after the tone.');
    response.record({
      maxLength: 120,
      transcribe: true,
      playBeep: true,
    });

    return response.toString();
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
