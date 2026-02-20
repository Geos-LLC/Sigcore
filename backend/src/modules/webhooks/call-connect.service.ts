import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as twilio from 'twilio';
import {
  CallConnectSettings,
  CallConnectMode,
} from '../../database/entities/call-connect-settings.entity';
import {
  CallConnectSession,
  SessionStatus,
  CallConnectProvider,
} from '../../database/entities/call-connect-session.entity';
import {
  CommunicationIntegration,
  ProviderType,
} from '../../database/entities/communication-integration.entity';
import { WebhookEventType } from '../../database/entities/webhook-subscription.entity';
import { EncryptionService } from '../../common/services/encryption.service';
import { OutboundWebhooksService } from './outbound-webhooks.service';
import { StartCallConnectDto } from './dto/start-call-connect.dto';
import { UpsertCallConnectSettingsDto } from './dto/upsert-call-connect-settings.dto';

/** Terminal statuses — no further transitions allowed */
const TERMINAL_STATUSES = new Set<SessionStatus>([
  SessionStatus.ENDED,
  SessionStatus.FAILED,
  SessionStatus.CANCELED,
]);

@Injectable()
export class CallConnectService {
  private readonly logger = new Logger(CallConnectService.name);

  constructor(
    @InjectRepository(CallConnectSettings)
    private settingsRepo: Repository<CallConnectSettings>,
    @InjectRepository(CallConnectSession)
    private sessionRepo: Repository<CallConnectSession>,
    @InjectRepository(CommunicationIntegration)
    private integrationRepo: Repository<CommunicationIntegration>,
    private encryptionService: EncryptionService,
    private outboundWebhooks: OutboundWebhooksService,
    private config: ConfigService,
  ) {}

  // ──────────────────────────────────────────────────────────────
  // Settings CRUD
  // ──────────────────────────────────────────────────────────────

  async upsertSettings(
    workspaceId: string,
    dto: UpsertCallConnectSettingsDto,
  ): Promise<CallConnectSettings> {
    let settings = await this.settingsRepo.findOne({
      where: { businessId: workspaceId },
    });

    if (settings) {
      Object.assign(settings, dto);
    } else {
      settings = this.settingsRepo.create({ businessId: workspaceId, ...dto });
    }

    return this.settingsRepo.save(settings);
  }

  async getSettings(workspaceId: string): Promise<CallConnectSettings | null> {
    return this.settingsRepo.findOne({ where: { businessId: workspaceId } });
  }

  // ──────────────────────────────────────────────────────────────
  // Session lifecycle
  // ──────────────────────────────────────────────────────────────

  /**
   * Start a new Call Connect session.
   * Idempotent: returns the existing session if one already exists for (businessId, leadId).
   */
  async startSession(
    workspaceId: string,
    dto: StartCallConnectDto,
  ): Promise<{ sessionId: string; status: SessionStatus }> {
    // 1. Load & validate settings
    const settings = await this.settingsRepo.findOne({
      where: { businessId: workspaceId },
    });

    if (!settings?.enabled) {
      throw new UnprocessableEntityException(
        'Call Connect is not enabled for this business',
      );
    }

    // 2. Quiet-hours check
    if (settings.quietHours && this.isQuietHours(settings.quietHours)) {
      throw new UnprocessableEntityException(
        'Call Connect is disabled during quiet hours',
      );
    }

    // 3. Idempotency — return existing session if already started
    const existing = await this.sessionRepo.findOne({
      where: { businessId: workspaceId, leadId: dto.leadId },
    });
    if (existing) {
      this.logger.log(
        `Call Connect session already exists for lead ${dto.leadId}: ${existing.id}`,
      );
      return { sessionId: existing.id, status: existing.status };
    }

    // 4. Resolve caller-ID and agent phone
    const fromNumber = settings.botNumberE164;
    if (!fromNumber) {
      throw new UnprocessableEntityException(
        'Bot number not configured in Call Connect settings',
      );
    }

    const agentPhone = dto.agentHint || settings.agentPhoneE164;
    if (!agentPhone) {
      throw new UnprocessableEntityException(
        'Agent phone not configured and no agentHint provided',
      );
    }

    const mode =
      (dto.requestedMode as CallConnectMode) || settings.mode;
    const conferenceName = `cc_${Date.now()}`; // will be updated after session saved

    // 5. Create session row
    const session = this.sessionRepo.create({
      businessId: workspaceId,
      leadId: dto.leadId,
      leadPhoneE164: dto.leadPhoneE164,
      leadSummary: dto.leadSummary,
      agentPhoneE164: agentPhone,
      mode,
      status: SessionStatus.CREATED,
      provider: CallConnectProvider.TWILIO,
      fromNumberE164: fromNumber,
      timeline: [],
    });

    await this.sessionRepo.save(session);
    session.conferenceName = `cc_${session.id}`;
    await this.sessionRepo.save(session);

    this.logger.log(
      `Created Call Connect session ${session.id} for lead ${dto.leadId} (mode=${mode})`,
    );

    // 6. Emit session.created event to LeadBridge
    await this.emitEvent(session, WebhookEventType.CALL_CONNECT_SESSION_CREATED);

    // 7. Start calls per mode (fire-and-forget; failures will be caught and recorded)
    this.initiateMode(session, settings).catch((err) => {
      this.logger.error(
        `Failed to initiate call connect mode for session ${session.id}: ${err.message}`,
      );
      this.failSession(session, `Initiation error: ${err.message}`).catch(() => {});
    });

    return { sessionId: session.id, status: session.status };
  }

  /**
   * Cancel an active session. Hangs up any live calls.
   */
  async cancelSession(workspaceId: string, sessionId: string): Promise<void> {
    const session = await this.sessionRepo.findOne({
      where: { id: sessionId, businessId: workspaceId },
    });

    if (!session) {
      throw new NotFoundException(`Session ${sessionId} not found`);
    }

    if (TERMINAL_STATUSES.has(session.status)) {
      this.logger.log(`Session ${sessionId} already terminal (${session.status}), skipping cancel`);
      return;
    }

    try {
      const client = await this.getTwilioClient(workspaceId);
      if (session.agentCallSid) {
        await client.calls(session.agentCallSid).update({ status: 'canceled' }).catch(() => {});
      }
      if (session.leadCallSid) {
        await client.calls(session.leadCallSid).update({ status: 'canceled' }).catch(() => {});
      }
    } catch (err: any) {
      this.logger.warn(`Could not hang up calls for session ${sessionId}: ${err.message}`);
    }

    await this.updateSession(session, {
      status: SessionStatus.CANCELED,
      failureReason: 'Canceled by caller',
    });
  }

  // ──────────────────────────────────────────────────────────────
  // TwiML generators (called by WebhooksController)
  // ──────────────────────────────────────────────────────────────

  /**
   * Returns TwiML for the agent leg.
   * AGENT_FIRST: whisper + Gather digit
   * PARALLEL: directly join conference
   */
  async handleAgentTwiml(sessionId: string): Promise<string> {
    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session) {
      this.logger.error(`Agent TwiML: session ${sessionId} not found`);
      return this.hangupTwiml();
    }

    const settings = await this.settingsRepo.findOne({
      where: { businessId: session.businessId },
    });

    const baseUrl = this.config.get<string>('BASE_URL');
    const response = new twilio.twiml.VoiceResponse();

    if (session.mode === CallConnectMode.AGENT_FIRST) {
      const summary = session.leadSummary || 'a new lead';
      response.say(`You have a new lead: ${summary}. Press ${settings?.agentAcceptDigits || '1'} to connect.`);

      const gather = response.gather({
        numDigits: 1,
        action: `${baseUrl}/api/webhooks/twilio/voice/agent/gather?sessionId=${sessionId}`,
        method: 'POST',
        timeout: settings?.ringTimeoutSeconds || 20,
      });
      gather.say(''); // keep gather active during timeout

      response.say('No input received. Goodbye.');
      response.hangup();
    } else {
      // PARALLEL: agent joins conference immediately
      response.say('Connecting you now.');
      const dial = response.dial();
      dial.conference(
        { startConferenceOnEnter: true, endConferenceOnExit: true },
        session.conferenceName,
      );
    }

    return response.toString();
  }

  /**
   * Returns TwiML for the lead leg — always joins the conference.
   */
  async handleLeadTwiml(sessionId: string): Promise<string> {
    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session) {
      this.logger.error(`Lead TwiML: session ${sessionId} not found`);
      return this.hangupTwiml();
    }

    const response = new twilio.twiml.VoiceResponse();
    response.say('Please hold while we connect you.');
    const dial = response.dial();
    dial.conference(
      { startConferenceOnEnter: false, endConferenceOnExit: true },
      session.conferenceName,
    );

    return response.toString();
  }

  /**
   * Handles the Gather action callback when the agent presses a digit.
   * Returns TwiML: conference join if accepted, hangup if declined.
   */
  async handleAgentGatherAction(
    sessionId: string,
    digits: string,
  ): Promise<string> {
    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session || TERMINAL_STATUSES.has(session.status)) {
      return this.hangupTwiml();
    }

    const settings = await this.settingsRepo.findOne({
      where: { businessId: session.businessId },
    });
    const acceptDigit = settings?.agentAcceptDigits || '1';

    if (digits === acceptDigit) {
      // Agent accepted — update session and initiate lead call
      await this.updateSession(session, { status: SessionStatus.AGENT_ACCEPTED });
      await this.emitEvent(session, WebhookEventType.CALL_CONNECT_AGENT_ACCEPTED);

      // Initiate lead call (fire-and-forget)
      this.initiateLeadCall(session).catch((err) => {
        this.logger.error(`Failed to initiate lead call for session ${session.id}: ${err.message}`);
        this.failSession(session, `Lead call initiation failed: ${err.message}`).catch(() => {});
      });

      // Return conference TwiML for agent
      const response = new twilio.twiml.VoiceResponse();
      response.say('Connecting you to the lead now.');
      const dial = response.dial();
      dial.conference(
        { startConferenceOnEnter: true, endConferenceOnExit: true },
        session.conferenceName,
      );
      return response.toString();
    } else {
      // Agent declined
      this.logger.log(`Agent declined call for session ${session.id} (digit=${digits})`);
      await this.tryNextAgentOrFail(session, settings, 'Agent declined');
      return this.hangupTwiml();
    }
  }

  /**
   * Called by TwilioWebhooksService.handleCallStatus() for every Twilio status callback.
   * Checks if the CallSid belongs to a call-connect session and advances the state machine.
   */
  async handleProviderCallStatus(
    callSid: string,
    callStatus: string,
    callDuration?: string,
  ): Promise<void> {
    // Find session by agent or lead CallSid
    const session = await this.sessionRepo
      .createQueryBuilder('s')
      .where('s.agent_call_sid = :sid OR s.lead_call_sid = :sid', { sid: callSid })
      .getOne();

    if (!session) return; // Not a call-connect call

    if (TERMINAL_STATUSES.has(session.status)) {
      this.logger.debug(`Session ${session.id} already terminal, ignoring status ${callStatus}`);
      return;
    }

    const isAgentLeg = session.agentCallSid === callSid;
    const isLeadLeg = session.leadCallSid === callSid;

    this.logger.log(
      `Call Connect status: session=${session.id}, ${isAgentLeg ? 'AGENT' : 'LEAD'} leg, status=${callStatus}`,
    );

    const settings = await this.settingsRepo.findOne({
      where: { businessId: session.businessId },
    });

    switch (callStatus) {
      case 'ringing':
        if (isAgentLeg && session.status === SessionStatus.CALLING_AGENT) {
          await this.emitEvent(session, WebhookEventType.CALL_CONNECT_AGENT_RINGING);
        } else if (isLeadLeg && session.status === SessionStatus.CALLING_LEAD) {
          await this.emitEvent(session, WebhookEventType.CALL_CONNECT_LEAD_RINGING);
        }
        break;

      case 'in-progress':
        if (isAgentLeg && session.status === SessionStatus.CALLING_AGENT) {
          await this.updateSession(session, { status: SessionStatus.AGENT_ANSWERED });
          // For PARALLEL mode: agent is in conference, now emit bridged if lead also in
          if (session.mode === CallConnectMode.PARALLEL && session.leadCallSid) {
            await this.updateSession(session, { status: SessionStatus.BRIDGED });
            await this.emitEvent(session, WebhookEventType.CALL_CONNECT_BRIDGED);
          }
        } else if (isLeadLeg) {
          if (session.status !== SessionStatus.BRIDGED) {
            await this.updateSession(session, {
              status: SessionStatus.LEAD_ANSWERED,
            });
            // Both legs in-progress → bridged
            await this.updateSession(session, { status: SessionStatus.BRIDGED });
            await this.emitEvent(session, WebhookEventType.CALL_CONNECT_BRIDGED);
          }
        }
        break;

      case 'completed':
        if (session.status === SessionStatus.BRIDGED) {
          const updates: Partial<CallConnectSession> = { status: SessionStatus.ENDED };
          if (callDuration) {
            updates.timeline = [
              ...session.timeline,
              { event: 'ended', callSid, duration: parseInt(callDuration), at: new Date().toISOString() },
            ];
          }
          await this.updateSession(session, updates);
          await this.emitEvent(session, WebhookEventType.CALL_CONNECT_ENDED);
        }
        break;

      case 'no-answer':
      case 'busy':
      case 'failed':
      case 'canceled':
        if (isAgentLeg && session.status === SessionStatus.CALLING_AGENT) {
          await this.tryNextAgentOrFail(
            session,
            settings,
            `Agent ${callStatus}`,
          );
        } else if (isLeadLeg) {
          await this.failSession(session, `Lead ${callStatus}`);
        }
        break;
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Session getters
  // ──────────────────────────────────────────────────────────────

  async getSession(workspaceId: string, sessionId: string): Promise<CallConnectSession> {
    const session = await this.sessionRepo.findOne({
      where: { id: sessionId, businessId: workspaceId },
    });
    if (!session) {
      throw new NotFoundException(`Session ${sessionId} not found`);
    }
    return session;
  }

  // ──────────────────────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────────────────────

  private async initiateMode(
    session: CallConnectSession,
    settings: CallConnectSettings,
  ): Promise<void> {
    if (session.mode === CallConnectMode.AGENT_FIRST) {
      await this.startAgentFirstMode(session, settings);
    } else {
      await this.startParallelMode(session, settings);
    }
  }

  private async startAgentFirstMode(
    session: CallConnectSession,
    settings: CallConnectSettings,
  ): Promise<void> {
    const client = await this.getTwilioClient(session.businessId);
    const baseUrl = this.config.get<string>('BASE_URL');

    this.logger.log(
      `AGENT_FIRST: calling agent ${session.agentPhoneE164} for session ${session.id}`,
    );

    const call = await client.calls.create({
      to: session.agentPhoneE164,
      from: session.fromNumberE164,
      url: `${baseUrl}/api/webhooks/twilio/voice/agent?sessionId=${session.id}`,
      statusCallback: `${baseUrl}/api/webhooks/twilio/voice/status`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      timeout: settings.ringTimeoutSeconds,
    });

    await this.updateSession(session, {
      status: SessionStatus.CALLING_AGENT,
      agentCallSid: call.sid,
    });

    this.logger.log(`Agent call initiated: ${call.sid}`);
  }

  private async startParallelMode(
    session: CallConnectSession,
    settings: CallConnectSettings,
  ): Promise<void> {
    const client = await this.getTwilioClient(session.businessId);
    const baseUrl = this.config.get<string>('BASE_URL');

    this.logger.log(
      `PARALLEL: calling agent ${session.agentPhoneE164} and lead ${session.leadPhoneE164} for session ${session.id}`,
    );

    const [agentCall, leadCall] = await Promise.all([
      client.calls.create({
        to: session.agentPhoneE164,
        from: session.fromNumberE164,
        url: `${baseUrl}/api/webhooks/twilio/voice/agent?sessionId=${session.id}`,
        statusCallback: `${baseUrl}/api/webhooks/twilio/voice/status`,
        statusCallbackMethod: 'POST',
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        timeout: settings.ringTimeoutSeconds,
      }),
      client.calls.create({
        to: session.leadPhoneE164,
        from: session.fromNumberE164,
        url: `${baseUrl}/api/webhooks/twilio/voice/lead?sessionId=${session.id}`,
        statusCallback: `${baseUrl}/api/webhooks/twilio/voice/status`,
        statusCallbackMethod: 'POST',
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        timeout: settings.ringTimeoutSeconds,
      }),
    ]);

    await this.updateSession(session, {
      status: SessionStatus.CALLING_AGENT,
      agentCallSid: agentCall.sid,
      leadCallSid: leadCall.sid,
    });

    this.logger.log(
      `Parallel calls initiated: agent=${agentCall.sid}, lead=${leadCall.sid}`,
    );
  }

  private async initiateLeadCall(session: CallConnectSession): Promise<void> {
    const client = await this.getTwilioClient(session.businessId);
    const baseUrl = this.config.get<string>('BASE_URL');
    const settings = await this.settingsRepo.findOne({
      where: { businessId: session.businessId },
    });

    this.logger.log(
      `Initiating lead call ${session.leadPhoneE164} for session ${session.id}`,
    );

    const leadCall = await client.calls.create({
      to: session.leadPhoneE164,
      from: session.fromNumberE164,
      url: `${baseUrl}/api/webhooks/twilio/voice/lead?sessionId=${session.id}`,
      statusCallback: `${baseUrl}/api/webhooks/twilio/voice/status`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      timeout: settings?.ringTimeoutSeconds || 30,
    });

    await this.updateSession(session, {
      status: SessionStatus.CALLING_LEAD,
      leadCallSid: leadCall.sid,
    });

    this.logger.log(`Lead call initiated: ${leadCall.sid}`);
    await this.emitEvent(session, WebhookEventType.CALL_CONNECT_LEAD_RINGING);
  }

  private async tryNextAgentOrFail(
    session: CallConnectSession,
    settings: CallConnectSettings | null,
    reason: string,
  ): Promise<void> {
    const maxAttempts = settings?.maxAgentAttempts ?? 2;
    if (session.attempt < maxAttempts) {
      // Future: pick next agent via ROUND_ROBIN / ON_DUTY strategy
      // For now: re-try the same agent after 5 seconds
      this.logger.log(
        `Session ${session.id}: agent attempt ${session.attempt}/${maxAttempts} failed (${reason}). Retrying...`,
      );
      await this.updateSession(session, {
        status: SessionStatus.CREATED,
        attempt: session.attempt + 1,
        agentCallSid: null as any,
      });

      if (settings) {
        setTimeout(() => {
          this.startAgentFirstMode(session, settings).catch((err) => {
            this.logger.error(`Retry failed for session ${session.id}: ${err.message}`);
            this.failSession(session, `Retry failed: ${err.message}`).catch(() => {});
          });
        }, 5000);
      }
    } else {
      await this.failSession(session, `Max agent attempts reached: ${reason}`);
    }
  }

  private async failSession(
    session: CallConnectSession,
    reason: string,
  ): Promise<void> {
    this.logger.warn(`Session ${session.id} FAILED: ${reason}`);
    await this.updateSession(session, {
      status: SessionStatus.FAILED,
      failureReason: reason,
    });
    await this.emitEvent(session, WebhookEventType.CALL_CONNECT_FAILED, { reason });
  }

  private async updateSession(
    session: CallConnectSession,
    updates: Partial<CallConnectSession>,
  ): Promise<void> {
    const timelineEntry = {
      status: updates.status,
      at: new Date().toISOString(),
      ...(updates.failureReason ? { reason: updates.failureReason } : {}),
    };

    Object.assign(session, updates);

    if (updates.status) {
      session.timeline = [
        ...(session.timeline || []),
        timelineEntry,
      ];
    }

    await this.sessionRepo.save(session);
  }

  private async emitEvent(
    session: CallConnectSession,
    eventType: WebhookEventType,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.outboundWebhooks.emitEvent(session.businessId, eventType, {
        sessionId: session.id,
        leadId: session.leadId,
        businessId: session.businessId,
        status: session.status,
        mode: session.mode,
        agentPhone: session.agentPhoneE164,
        leadPhone: session.leadPhoneE164,
        attempt: session.attempt,
        updatedAt: new Date().toISOString(),
        ...extra,
      });
    } catch (err: any) {
      this.logger.error(`Failed to emit ${eventType} for session ${session.id}: ${err.message}`);
    }
  }

  private async getTwilioClient(workspaceId: string): Promise<twilio.Twilio> {
    const integration = await this.integrationRepo.findOne({
      where: { workspaceId, provider: ProviderType.TWILIO },
    });

    if (!integration?.credentialsEncrypted) {
      throw new Error(`No Twilio integration found for workspace ${workspaceId}`);
    }

    const credentials = JSON.parse(
      this.encryptionService.decrypt(integration.credentialsEncrypted),
    );

    return twilio(credentials.accountSid, credentials.authToken);
  }

  /** Check if current time is within configured quiet hours */
  private isQuietHours(quietHours: Record<string, unknown>): boolean {
    try {
      const { timezone, start, end } = quietHours as {
        timezone?: string;
        start?: string; // "HH:MM"
        end?: string;
      };

      if (!start || !end) return false;

      const tz = timezone || 'UTC';
      const now = new Date();
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });

      const nowTime = formatter.format(now); // e.g. "22:30"
      return nowTime >= start && nowTime <= end;
    } catch {
      return false;
    }
  }

  private hangupTwiml(): string {
    const r = new twilio.twiml.VoiceResponse();
    r.hangup();
    return r.toString();
  }
}
