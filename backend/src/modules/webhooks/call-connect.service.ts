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
  AgentVoicemailMode,
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
import { TenantIntegration } from '../../database/entities/tenant-integration.entity';
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

  /** Resolve the public base URL for Twilio callbacks, with Railway fallback */
  private getBaseUrl(): string {
    const configured = this.config.get<string>('BASE_URL');
    if (configured) return configured.replace(/\/$/, '');

    // Railway auto-sets RAILWAY_PUBLIC_DOMAIN (no protocol prefix)
    const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
    if (railwayDomain) return `https://${railwayDomain}`;

    return 'http://localhost:3002';
  }

  constructor(
    @InjectRepository(CallConnectSettings)
    private settingsRepo: Repository<CallConnectSettings>,
    @InjectRepository(CallConnectSession)
    private sessionRepo: Repository<CallConnectSession>,
    @InjectRepository(CommunicationIntegration)
    private integrationRepo: Repository<CommunicationIntegration>,
    @InjectRepository(TenantIntegration)
    private tenantIntegrationRepo: Repository<TenantIntegration>,
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
    tenantId?: string,
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
      tenantId: tenantId || undefined,
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
      const client = await this.getTwilioClient(workspaceId, session.tenantId);
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

    const baseUrl = this.getBaseUrl();
    const response = new twilio.twiml.VoiceResponse();

    if (session.mode === CallConnectMode.AGENT_FIRST) {
      const digit = settings?.agentAcceptDigits || '1';
      const summary = session.leadSummary || 'a new lead';
      const template =
        settings?.agentWhisperMessage ||
        'You have a new lead: {summary}. Press {digit} to connect.';
      const whisper = template
        .replace(/\{summary\}/g, summary)
        .replace(/\{digit\}/g, digit);
      // Play the whisper BEFORE the gather so the agent hears the full message
      // and has the complete gather window to press a digit.
      response.say(whisper);

      // 15s is plenty after the whisper; fast-answer detection in handleProviderCallStatus
      // already short-circuits voicemail calls before this TwiML runs.
      const gatherTimeout = Math.min(settings?.ringTimeoutSeconds ?? 20, 15);
      const gather = response.gather({
        numDigits: 1,
        action: `${baseUrl}/api/webhooks/twilio/voice/agent/gather?sessionId=${sessionId}`,
        method: 'POST',
        timeout: gatherTimeout,
      });
      gather.say('');

      response.say('No input received. Goodbye.');
      response.hangup();
    } else {
      // PARALLEL: agent joins conference immediately
      const digit = settings?.agentAcceptDigits || '1';
      const summary = session.leadSummary || 'a new lead';
      const template =
        settings?.agentWhisperMessage ||
        'Connecting you to a new lead: {summary}.';
      const whisper = template
        .replace(/\{summary\}/g, summary)
        .replace(/\{digit\}/g, digit);
      response.say(whisper);
      const dial = response.dial();
      dial.conference(
        { startConferenceOnEnter: true, endConferenceOnExit: true },
        session.conferenceName,
      );
    }

    return response.toString();
  }

  /**
   * Returns TwiML for the lead leg — joins the conference immediately.
   * Greeting is played via the conference waitUrl (eliminates TTS startup delay
   * on pick-up: lead hears hold music right away instead of waiting for TTS).
   */
  async handleLeadTwiml(sessionId: string): Promise<string> {
    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session) {
      this.logger.error(`Lead TwiML: session ${sessionId} not found`);
      return this.hangupTwiml();
    }

    const settings = await this.settingsRepo.findOne({
      where: { businessId: session.businessId },
    });

    const baseUrl = this.getBaseUrl();
    const response = new twilio.twiml.VoiceResponse();
    const dial = response.dial();

    // Always use waitUrl so lead joins the conference immediately (no TTS startup delay).
    // Twilio fetches the greeting from /lead/wait while hold music plays — zero silence on pick-up.
    const waitUrl = `${baseUrl}/api/webhooks/twilio/voice/lead/wait?sessionId=${sessionId}`;

    dial.conference(
      { startConferenceOnEnter: false, endConferenceOnExit: true, waitUrl, waitMethod: 'POST' } as any,
      session.conferenceName,
    );

    return response.toString();
  }

  /**
   * Conference waitUrl TwiML — looping greeting played to lead while waiting for agent.
   * Runs inside the conference hold state (after lead has already connected, no TTS delay).
   */
  async handleLeadWaitTwiml(sessionId: string): Promise<string> {
    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session) return this.hangupTwiml();

    const settings = await this.settingsRepo.findOne({
      where: { businessId: session.businessId },
    });

    const greeting = settings?.leadGreetingMessage || 'Please hold while we connect you.';
    const baseUrl = this.getBaseUrl();

    const response = new twilio.twiml.VoiceResponse();
    response.say(greeting);
    response.pause({ length: 3 });
    // Loop: redirect back to this endpoint so the greeting repeats
    response.redirect(
      { method: 'POST' },
      `${baseUrl}/api/webhooks/twilio/voice/lead/wait?sessionId=${sessionId}`,
    );

    return response.toString();
  }

  /**
   * Returns TwiML that plays the configured voicemail drop message.
   * Called by Twilio when we redirect a lead call that hit voicemail.
   */
  async handleLeadVoicemailTwiml(sessionId: string): Promise<string> {
    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session) return this.hangupTwiml();

    const settings = await this.settingsRepo.findOne({
      where: { businessId: session.businessId },
    });

    const message =
      settings?.leadVoicemailMessage ||
      'Hi, we tried to reach you about an inquiry. Please call us back at your earliest convenience.';

    const response = new twilio.twiml.VoiceResponse();
    // Brief pause so the message lands after the voicemail beep.
    // AMD fires at 'machine_start' (before the beep) when redirecting on the first call;
    // the second (DetectMessageEnd) call already waits for the beep so the pause is a no-op.
    response.pause({ length: 2 });
    response.say(message);
    response.hangup();

    await this.updateSession(session, { status: SessionStatus.ENDED });
    await this.emitEvent(session, WebhookEventType.CALL_CONNECT_ENDED, {
      reason: 'voicemail_drop',
    });

    return response.toString();
  }

  /**
   * TwiML for the agent in SPEAK voicemail mode.
   * Plays a brief notification then parks the agent in a private conference,
   * waiting for the lead's voicemail leg to join and start the conference.
   */
  async handleAgentVoicemailHoldTwiml(sessionId: string): Promise<string> {
    const response = new twilio.twiml.VoiceResponse();
    response.say(
      "The customer didn't answer. You'll be connected to their voicemail. Please leave a message after the beep, then hang up when done.",
    );
    response.pause({ length: 1 });
    const dial = response.dial();
    dial.conference(
      { startConferenceOnEnter: false, endConferenceOnExit: true } as any,
      `ccvm_${sessionId}`,
    );
    return response.toString();
  }

  /**
   * TwiML for the lead's voicemail leg in SPEAK voicemail mode.
   * Called by Twilio after DetectMessageEnd fires (beep detected).
   * Joins the same conference as the agent, which starts the conference
   * and bridges both legs — the agent then speaks directly into the voicemail.
   */
  async handleLeadVoicemailAgentTwiml(sessionId: string): Promise<string> {
    const response = new twilio.twiml.VoiceResponse();
    const dial = response.dial();
    dial.conference(
      { startConferenceOnEnter: true, endConferenceOnExit: true } as any,
      `ccvm_${sessionId}`,
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
   * Handles the async Answering Machine Detection (AMD) callback from Twilio.
   * If voicemail is detected, we cancel the agent call and retry/fail.
   */
  async handleAgentAmd(sessionId: string, callSid: string, answeredBy: string): Promise<void> {
    const isMachine =
      answeredBy === 'machine_start' ||
      answeredBy === 'machine_end_beep' ||
      answeredBy === 'machine_end_silence' ||
      answeredBy === 'machine_end_other' ||
      answeredBy === 'fax';

    this.logger.log(
      `[AMD] Agent AMD fired for session ${sessionId}: answeredBy=${answeredBy}, isMachine=${isMachine}`,
    );

    if (!isMachine) {
      // Human picked up — let normal whisper+gather flow continue
      this.logger.log(`[AMD] Human detected for session ${sessionId}, gather flow continuing`);
      return;
    }

    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session || TERMINAL_STATUSES.has(session.status)) return;

    const settings = await this.settingsRepo.findOne({
      where: { businessId: session.businessId },
    });

    // Hang up the voicemail call
    try {
      const client = await this.getTwilioClient(session.businessId, session.tenantId);
      await client.calls(callSid).update({ status: 'completed' }).catch(() => {});
    } catch (err: any) {
      this.logger.warn(`Could not hang up machine call ${callSid}: ${err.message}`);
    }

    await this.tryNextAgentOrFail(session, settings, `Voicemail detected (${answeredBy})`);
  }

  /**
   * Handles AMD callback for the lead leg.
   * If voicemail detected and voicemail drop is enabled, redirects the call
   * to play the voicemail drop message.
   */
  async handleLeadAmd(sessionId: string, callSid: string, answeredBy: string): Promise<void> {
    const isMachine =
      answeredBy === 'machine_start' ||
      answeredBy === 'machine_end_beep' ||
      answeredBy === 'machine_end_silence' ||
      answeredBy === 'machine_end_other' ||
      answeredBy === 'fax';

    this.logger.log(
      `Lead AMD result for session ${sessionId}: answeredBy=${answeredBy}, isMachine=${isMachine}`,
    );

    if (!isMachine) return; // Human answered — conference flow proceeds normally

    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session || TERMINAL_STATUSES.has(session.status)) return;

    const settings = await this.settingsRepo.findOne({
      where: { businessId: session.businessId },
    });

    if (!settings?.leadVoicemailEnabled || !settings.leadVoicemailMessage) {
      // Voicemail drop not configured — just hang up and fail
      try {
        const client = await this.getTwilioClient(session.businessId, session.tenantId);
        await client.calls(callSid).update({ status: 'completed' }).catch(() => {});
      } catch {}
      await this.failSession(session, `Lead did not answer (${answeredBy})`);
      return;
    }

    // Redirect call to voicemail drop TwiML
    const baseUrl = this.getBaseUrl();
    try {
      const client = await this.getTwilioClient(session.businessId, session.tenantId);
      await client.calls(callSid).update({
        url: `${baseUrl}/api/webhooks/twilio/voice/lead/voicemail?sessionId=${sessionId}`,
        method: 'POST',
      });
      this.logger.log(`Voicemail drop initiated for session ${sessionId}`);
    } catch (err: any) {
      this.logger.error(`Failed to redirect lead call to voicemail for session ${sessionId}: ${err.message}`);
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
          if (session.mode === CallConnectMode.AGENT_FIRST) {
            // Voicemail answers in 0-4s. Humans almost never pick up in < 5s.
            // Detect fast answer and immediately retry instead of waiting for gather timeout.
            // This handles "Silence Unknown Callers" (iOS) and similar carrier voicemail routing.
            const msSinceCalling = Date.now() - session.updatedAt.getTime();
            if (msSinceCalling < 5000) {
              this.logger.log(
                `Session ${session.id}: agent answered in ${msSinceCalling}ms — voicemail (fast answer), retrying`,
              );
              try {
                const client = await this.getTwilioClient(session.businessId, session.tenantId);
                await client.calls(callSid).update({ status: 'completed' }).catch(() => {});
              } catch { /* ignore — call may have already ended */ }
              await this.tryNextAgentOrFail(session, settings, `Voicemail (answered in ${msSinceCalling}ms)`);
              return;
            }
          }
          await this.updateSession(session, { status: SessionStatus.AGENT_ANSWERED });
          await this.emitEvent(session, WebhookEventType.CALL_CONNECT_AGENT_RINGING);
          // PARALLEL: wait for lead to also answer before marking BRIDGED
        } else if (isLeadLeg && session.status !== SessionStatus.BRIDGED) {
          await this.updateSession(session, { status: SessionStatus.LEAD_ANSWERED });
          await this.updateSession(session, { status: SessionStatus.BRIDGED });
          await this.emitEvent(session, WebhookEventType.CALL_CONNECT_BRIDGED);
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
        } else if (isAgentLeg && session.status === SessionStatus.CALLING_AGENT) {
          // Call ended before the agent answered.
          // Fast-answer detection already handles voicemail (hangs up + retries there).
          // This path catches cases where the call was terminated for other reasons.
          this.logger.log(`Session ${session.id}: agent call completed before answering`);
          await this.tryNextAgentOrFail(session, settings, 'Agent call ended before answer');
        } else if (isAgentLeg && session.status === SessionStatus.AGENT_ANSWERED) {
          // Agent answered and then hung up without pressing the accept digit.
          // With fast-answer detection in place, this is always a real human who chose
          // not to connect — do NOT retry (retrying immediately would call them again
          // while they're still processing the first call / are actively declining).
          this.logger.log(
            `Session ${session.id}: agent answered but did not accept (hung up or gather timeout)`,
          );
          await this.failSession(session, 'Agent answered but did not accept');
        } else if (isAgentLeg && session.status === SessionStatus.CALLING_LEAD) {
          // AGENT_FIRST: agent accepted but dropped while lead was ringing.
          // Cancel the lead call and fail — the agent issue is the root cause.
          this.logger.log(`Session ${session.id}: agent dropped while lead was ringing`);
          await this.hangUpLeadCall(session);
          await this.failSession(session, 'Agent disconnected while calling lead');
        } else if (isLeadLeg) {
          await this.failSession(session, 'Lead call ended before bridging');
        }
        break;

      case 'no-answer':
      case 'busy':
      case 'failed':
      case 'canceled':
        if (isAgentLeg) {
          if (
            session.status === SessionStatus.CALLING_AGENT ||
            session.status === SessionStatus.AGENT_ANSWERED
          ) {
            // Standard: agent didn't pick up before lead was called
            await this.tryNextAgentOrFail(session, settings, `Agent ${callStatus}`);
          } else if (
            session.status === SessionStatus.LEAD_ANSWERED ||
            session.status === SessionStatus.BRIDGED
          ) {
            // PARALLEL: lead is already waiting in the conference but agent failed to join
            this.logger.log(
              `Session ${session.id}: agent ${callStatus} while lead was waiting in conference`,
            );
            await this.hangUpLeadCall(session);
            await this.failSession(session, `Agent ${callStatus} — lead was left waiting`);
          }
        } else if (isLeadLeg && session.status !== SessionStatus.BRIDGED) {
          // Lead didn't answer (no-answer) or declined (busy).
          // If the carrier forwards to voicemail after decline, voicemail picks up the
          // FIRST call and AMD handles it via handleLeadAmd(). Getting 'busy' here means
          // the carrier did NOT forward to voicemail — a second call won't reach it either.
          // no-answer after 60s similarly means voicemail never engaged. Just fail.
          await this.failSession(session, `Lead ${callStatus} — no voicemail engaged`);
        }
        // If lead no-answer but session already BRIDGED, ignore (conference handles its own end)
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
    const client = await this.getTwilioClient(session.businessId, session.tenantId);
    const baseUrl = this.getBaseUrl();

    this.logger.log(
      `AGENT_FIRST: calling agent ${session.agentPhoneE164} for session ${session.id}`,
    );

    // No machineDetection here: asyncAmdStatusCallback was never invoked by Twilio,
    // meaning it ran synchronously and blocked TwiML execution for ~6 seconds (audible
    // silence after the agent picks up). Voicemail detection is handled instead by
    // fast-answer heuristic in handleProviderCallStatus (< 5s answer → voicemail).
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
    const client = await this.getTwilioClient(session.businessId, session.tenantId);
    const baseUrl = this.getBaseUrl();

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
        // When voicemail is enabled, use 60s — the maximum carriers take to forward
        // to voicemail. AMD will detect the machine and redirect the call to play the
        // message on this same call. If we still get no-answer after 60s, voicemail
        // is not set up and no second call is attempted.
        timeout: settings.leadVoicemailEnabled ? 60 : settings.ringTimeoutSeconds,
        ...(settings.leadVoicemailEnabled
          ? {
              machineDetection: 'Enable',
              asyncAmdStatusCallback: `${baseUrl}/api/webhooks/twilio/voice/lead/amd?sessionId=${session.id}`,
              asyncAmdStatusCallbackMethod: 'POST',
            }
          : {}),
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
    const client = await this.getTwilioClient(session.businessId, session.tenantId);
    const baseUrl = this.getBaseUrl();
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
      timeout: settings?.leadVoicemailEnabled ? 60 : (settings?.ringTimeoutSeconds ?? 30),
      ...(settings?.leadVoicemailEnabled
        ? {
            machineDetection: 'Enable',
            asyncAmdStatusCallback: `${baseUrl}/api/webhooks/twilio/voice/lead/amd?sessionId=${session.id}`,
            asyncAmdStatusCallbackMethod: 'POST',
          }
        : {}),
    });

    await this.updateSession(session, {
      status: SessionStatus.CALLING_LEAD,
      leadCallSid: leadCall.sid,
    });

    this.logger.log(`Lead call initiated: ${leadCall.sid}`);
    await this.emitEvent(session, WebhookEventType.CALL_CONNECT_LEAD_RINGING);
  }

  /**
   * Hangs up the active lead call via Twilio REST.
   * Used when the agent drops/fails and the lead would otherwise be left waiting.
   */
  private async hangUpLeadCall(session: CallConnectSession): Promise<void> {
    if (!session.leadCallSid) return;
    try {
      const client = await this.getTwilioClient(session.businessId, session.tenantId);
      await client.calls(session.leadCallSid).update({ status: 'completed' }).catch(() => {});
      this.logger.log(`Hung up lead call ${session.leadCallSid} for session ${session.id}`);
    } catch (err: any) {
      this.logger.warn(`Could not hang up lead call for session ${session.id}: ${err.message}`);
    }
  }

  /**
   * Makes a dedicated outbound call to the lead with DetectMessageEnd AMD.
   * Twilio waits for the voicemail beep, then executes the voicemail TwiML URL.
   * This reliably drops a voice message even when the lead's phone never picked up.
   */
  private async dropVoicemailToLead(
    session: CallConnectSession,
    settings: CallConnectSettings,
  ): Promise<void> {
    const baseUrl = this.getBaseUrl();
    const speakMode = settings.agentVoicemailMode === AgentVoicemailMode.SPEAK;

    this.logger.log(
      `Voicemail drop for session ${session.id} → ${session.leadPhoneE164} (mode=${speakMode ? 'SPEAK' : 'TTS'})`,
    );

    // Mark ENDED immediately — before any Twilio calls — so concurrent status callbacks
    // (e.g. agent 'completed' arriving milliseconds later) see a terminal status and bail out,
    // preventing a race condition that would overwrite this with FAILED.
    await this.updateSession(session, { status: SessionStatus.ENDED });
    await this.emitEvent(session, WebhookEventType.CALL_CONNECT_ENDED, {
      reason: 'voicemail_drop',
      voicemailMode: speakMode ? 'SPEAK' : 'TTS',
    });

    try {
      const client = await this.getTwilioClient(session.businessId, session.tenantId);

      if (speakMode && session.agentCallSid) {
        // SPEAK mode: redirect agent to a hold conference so they can leave a personal voicemail.
        // The lead voicemail call will join the same conference once the beep fires, bridging them.
        this.logger.log(`SPEAK mode: redirecting agent ${session.agentCallSid} to voicemail hold`);
        await client.calls(session.agentCallSid).update({
          url: `${baseUrl}/api/webhooks/twilio/voice/agent/voicemail-hold?sessionId=${session.id}`,
          method: 'POST',
        }).catch((err: any) => {
          this.logger.warn(`Could not redirect agent to voicemail hold: ${err.message}`);
        });
      } else {
        // TTS mode: release the agent — they are no longer needed.
        if (session.agentCallSid) {
          await client.calls(session.agentCallSid).update({ status: 'completed' }).catch(() => {});
          this.logger.log(`TTS mode: hung up agent call ${session.agentCallSid}`);
        }
      }

      // Voicemail URL differs by mode:
      // TTS  → plays the configured TTS message on the voicemail
      // SPEAK → joins the agent-hold conference so agent speaks directly
      const voicemailUrl = speakMode
        ? `${baseUrl}/api/webhooks/twilio/voice/lead/voicemail-agent?sessionId=${session.id}`
        : `${baseUrl}/api/webhooks/twilio/voice/lead/voicemail?sessionId=${session.id}`;

      await client.calls.create({
        to: session.leadPhoneE164,
        from: session.fromNumberE164,
        url: voicemailUrl,
        // DetectMessageEnd waits for the voicemail beep before executing TwiML.
        // 45s gives the carrier time to forward to voicemail (typically 25-30s)
        // plus Twilio's beep detection window.
        machineDetection: 'DetectMessageEnd',
        timeout: 45,
      });

      this.logger.log(`Voicemail drop call placed for session ${session.id}`);
    } catch (err: any) {
      this.logger.error(
        `Voicemail drop call failed for session ${session.id}: ${err.message}`,
      );
      await this.failSession(session, `Lead did not answer; voicemail drop failed: ${err.message}`);
    }
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
        // 2s delay: short enough to reach the agent quickly on retry,
        // long enough for the carrier to clear the previous call state.
        setTimeout(() => {
          this.startAgentFirstMode(session, settings).catch((err) => {
            this.logger.error(`Retry failed for session ${session.id}: ${err.message}`);
            this.failSession(session, `Retry failed: ${err.message}`).catch(() => {});
          });
        }, 2000);
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

    // Hang up any active Twilio calls so neither party is left on a dead line
    if (session.agentCallSid || session.leadCallSid) {
      try {
        const client = await this.getTwilioClient(session.businessId, session.tenantId);
        if (session.agentCallSid) {
          await client.calls(session.agentCallSid).update({ status: 'completed' }).catch(() => {});
        }
        if (session.leadCallSid) {
          await client.calls(session.leadCallSid).update({ status: 'completed' }).catch(() => {});
        }
      } catch (err: any) {
        this.logger.warn(`Could not hang up calls for failed session ${session.id}: ${err.message}`);
      }
    }

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

  private async getTwilioClient(
    workspaceId: string,
    tenantId?: string,
  ): Promise<twilio.Twilio> {
    // 1. Try tenant-level integration first (tenant-provisioned Twilio account)
    if (tenantId) {
      const tenantIntegration = await this.tenantIntegrationRepo.findOne({
        where: { workspaceId, tenantId, provider: ProviderType.TWILIO },
      });
      if (tenantIntegration?.credentialsEncrypted) {
        const credentials = JSON.parse(
          this.encryptionService.decrypt(tenantIntegration.credentialsEncrypted),
        );
        return twilio(credentials.accountSid, credentials.authToken);
      }
    }

    // 2. Fall back to workspace-level integration
    const integration = await this.integrationRepo.findOne({
      where: { workspaceId, provider: ProviderType.TWILIO },
    });

    if (!integration?.credentialsEncrypted) {
      throw new Error(
        `No Twilio integration found for workspace ${workspaceId}${tenantId ? ` / tenant ${tenantId}` : ''}`,
      );
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
