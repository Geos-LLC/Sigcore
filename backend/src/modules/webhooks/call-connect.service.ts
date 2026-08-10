import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as twilio from 'twilio';
import OpenAI from 'openai';
import { toFile } from 'openai/uploads';
import { ProviderContextResolver } from '../integrations/provider-context-resolver.service';
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

/**
 * Diagnostic telemetry for the Twilio account-selection incident (2026-07-14).
 * `TwilioLegSelection` carries the resolution result plus enough context to
 * emit one `call_connect_twilio_client_selected` line per outbound leg and
 * to attribute any `client.calls.create` failure to the exact integration
 * that was picked. Fields intentionally exclude the auth token.
 */
type TwilioLegSelectionSource = 'tenant' | 'workspace';
interface TwilioLegSelection {
  client: twilio.Twilio;
  integrationId: string;
  selectionSource: TwilioLegSelectionSource;
  providerAccountSid: string;
  providerSubaccountSid: string | null;
  /**
   * The integration id that OWNS `session.fromNumberE164` per our own
   * `tenant_phone_numbers` record. Distinct from `integrationId` above,
   * which is the integration the Twilio client was actually built from.
   * When these disagree, we've picked the wrong Twilio account for the
   * From-number. Today the field is populated from
   * `tenant_phone_numbers.metadata.integrationId` if present — that
   * column is not yet written by any provisioning path (see the
   * post-incident From-aware lookup design), so this field is `null`
   * in practice. Emitting it anyway so log-based comparisons work
   * automatically once the schema is in place.
   */
  selectedPhoneIntegrationId: string | null;
}
import { TenantPhoneNumber } from '../../database/entities/tenant-phone-number.entity';
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

  /**
   * Lazy OpenAI client for Whisper. Missing OPENAI_API_KEY disables the
   * transcript path — getOrGenerateTranscript then returns null with a
   * warn log; caller (LB) will retry on next hydrate.
   */
  private _openai: OpenAI | null | undefined;
  private get openai(): OpenAI | null {
    if (this._openai !== undefined) return this._openai;
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    this._openai = apiKey ? new OpenAI({ apiKey }) : null;
    return this._openai;
  }

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
    @InjectRepository(TenantPhoneNumber)
    private tenantPhoneRepo: Repository<TenantPhoneNumber>,
    private encryptionService: EncryptionService,
    private outboundWebhooks: OutboundWebhooksService,
    private config: ConfigService,
    /**
     * Incident 2026-07-14 Phase 3a — resolves the owning Twilio integration
     * for Call Connect Twilio client selection. Optional so existing spec
     * builders (which construct the service manually) keep compiling; when
     * unwired the code falls back to the pre-Phase-3a lookup so behavior is
     * unchanged. Wave-2 telemetry (`resolveTwilioSelection`) is preserved
     * on top of this — resolver picks the row, telemetry helpers report it.
     */
    @Optional()
    private providerContextResolver?: ProviderContextResolver,
  ) {}

  // ──────────────────────────────────────────────────────────────
  // Settings CRUD
  // ──────────────────────────────────────────────────────────────

  async upsertSettings(
    workspaceId: string,
    dto: UpsertCallConnectSettingsDto,
  ): Promise<CallConnectSettings> {
    // businessId (from request body) = LeadBridge savedAccountId (per-account PK).
    // Falls back to workspaceId for legacy callers that don't send businessId.
    const businessId = dto.businessId || workspaceId;

    let settings = await this.settingsRepo.findOne({
      where: { businessId },
    });

    // Ownership audit: warn when botNumberE164 is not in tenant_phone_numbers for this workspace.
    // Advisory only — Twilio enforces actual caller-ID ownership at the call level.
    if (dto.botNumberE164 && dto.botNumberE164 !== settings?.botNumberE164) {
      const allocation = await this.tenantPhoneRepo.findOne({
        where: { workspaceId, phoneNumber: dto.botNumberE164 },
      });
      if (!allocation) {
        this.logger.warn(
          `[upsertSettings] BOT_NUMBER_NOT_OWNED (advisory): ${dto.botNumberE164} has no allocation row for workspace ${workspaceId} — continuing`,
        );
      }
    }

    const { businessId: _ignored, ...rest } = dto;
    if (settings) {
      Object.assign(settings, { workspaceId, ...rest });
    } else {
      settings = this.settingsRepo.create({ businessId, workspaceId, ...rest });
    }

    this.logger.log(
      `[upsertSettings] workspace=${workspaceId} business=${businessId} bot=${dto.botNumberE164 ?? settings.botNumberE164 ?? 'N/A'} agent=${dto.agentPhoneE164 ?? settings.agentPhoneE164 ?? 'N/A'}`,
    );

    const saved = await this.settingsRepo.save(settings);

    // Clean up stale legacy CC settings: when per-account isolation is active
    // (businessId != workspaceId), delete any old row where businessId equals
    // a workspace/tenant ID (legacy pattern) to prevent routing from finding stale data.
    const botNum = saved.botNumberE164;
    if (botNum && businessId !== workspaceId) {
      const stale = await this.settingsRepo.find({
        where: { botNumberE164: botNum },
      });
      for (const row of stale) {
        // Only remove rows that look like legacy (businessId = some workspace/tenant ID,
        // not a LeadBridge savedAccountId). Legacy rows have workspaceId NULL or
        // workspaceId = businessId.
        if (row.businessId !== businessId && (!row.workspaceId || row.workspaceId === row.businessId)) {
          this.logger.warn(
            `[upsertSettings] Deleting stale legacy CC settings: businessId=${row.businessId} botNumberE164=${botNum} agentPhoneE164=${row.agentPhoneE164}`,
          );
          await this.settingsRepo.remove(row);
        }
      }
    }

    return saved;
  }

  async getSettings(
    workspaceId: string,
    businessId?: string,
  ): Promise<CallConnectSettings | null> {
    // Prefer per-account row; fall back to workspace-level legacy row
    const key = businessId || workspaceId;
    return this.settingsRepo.findOne({ where: { businessId: key } });
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
    // businessId = LeadBridge savedAccountId (per-account PK key).
    // Falls back to workspaceId for legacy callers that don't send businessId.
    const businessId = dto.businessId || workspaceId;

    // 1. Load settings — per-account row by businessId PK
    // New rows: businessId = savedAccountId; Legacy rows: businessId = workspaceId
    let settings = await this.settingsRepo.findOne({
      where: { businessId },
    });
    if (!settings && businessId !== workspaceId) {
      // Backward compat: legacy row where PK = workspaceId
      settings = await this.settingsRepo.findOne({
        where: { businessId: workspaceId },
      });
      if (settings) {
        this.logger.warn(
          `[startSession] Using legacy workspace-level settings for business=${businessId} — push settings with businessId to fix`,
        );
      }
    }

    this.logger.log(
      `[startSession] workspace=${workspaceId} business=${businessId} bot=${dto.fromNumberHint ?? 'N/A'} agent=${dto.agentHint ?? 'N/A'} lead=${dto.leadId}`,
    );

    if (!settings?.enabled) {
      throw new UnprocessableEntityException(
        'Call Connect is not enabled for this business',
      );
    }

    // Validate fromNumberHint matches configured bot number (advisory warning)
    if (dto.fromNumberHint && settings.botNumberE164 && dto.fromNumberHint !== settings.botNumberE164) {
      this.logger.warn(
        `[startSession] fromNumberHint=${dto.fromNumberHint} does not match settings.botNumberE164=${settings.botNumberE164} for business=${businessId}`,
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
    const fromNumber = dto.fromNumberHint || settings.botNumberE164;
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

    // Incident 2026-07-14 Phase 3a — stamp owning integration at session
    // creation time so downstream call rows + status forwards can be joined
    // without a phone→TPN lookup on every event. Best-effort — a resolver
    // NotFound falls back to null (session still starts; the Twilio client
    // selection later will surface any real config gap). Fail closed on
    // 403 cross-tenant / 409 ambiguous / 409 provider mismatch — those are
    // security-critical and safer than starting an unroutable session.
    let resolvedIntegrationIdForSession: string | null = null;
    if (this.providerContextResolver) {
      try {
        const ctx = await this.providerContextResolver.resolve({
          workspaceId,
          tenantId: tenantId || undefined,
          provider: ProviderType.TWILIO,
          fromNumber,
        });
        resolvedIntegrationIdForSession = ctx.integration.id;
      } catch (err) {
        if (!(err instanceof NotFoundException)) {
          throw err;
        }
        this.logger.warn(
          `[startSession] provider_context_not_found workspace=${workspaceId} tenant=${tenantId ?? 'null'} from=${fromNumber} — creating session without integrationId stamp`,
        );
      }
    }

    // 5. Create session row
    const session = this.sessionRepo.create({
      businessId: workspaceId,
      tenantId: tenantId || undefined,
      leadId: dto.leadId,
      leadPhoneE164: dto.leadPhoneE164,
      leadSummary: dto.leadSummary,
      agentPhoneE164: agentPhone,
      agentWhisperMessage: dto.agentWhisperMessage || undefined,
      leadGreetingMessage: dto.leadGreetingMessage || undefined,
      leadVoicemailMessage: dto.leadVoicemailMessage || undefined,
      recordAgentLeg: dto.recordAgentLeg ?? false,
      skipAgentWhisper: dto.skipAgentWhisper ?? false,
      mode,
      status: SessionStatus.CREATED,
      provider: CallConnectProvider.TWILIO,
      fromNumberE164: fromNumber,
      sigcoreConversationId: dto.sigcoreConversationId || undefined,
      communicationIntegrationId: resolvedIntegrationIdForSession,
      timeline: [],
    });

    await this.sessionRepo.save(session);
    session.conferenceName = `cc_${session.id}`;
    await this.sessionRepo.save(session);

    this.logger.log(
      `[startSession] Created session=${session.id} workspace=${workspaceId} business=${businessId} bot=${fromNumber} agent=${agentPhone} lead=${dto.leadId} mode=${mode} recordAgentLeg=${session.recordAgentLeg} skipAgentWhisper=${session.skipAgentWhisper} perSessionWhisper=${session.agentWhisperMessage ? 'yes' : 'no'} perSessionGreeting=${session.leadGreetingMessage ? 'yes' : 'no'} perSessionVoicemail=${session.leadVoicemailMessage ? 'yes' : 'no'}`,
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
      const client = await this.getTwilioClient(workspaceId, session.tenantId, session.fromNumberE164);
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

    if (session.mode === CallConnectMode.AGENT_FIRST && session.skipAgentWhisper) {
      // AI-agent leg: no whisper, no DTMF gate. Kick off the lead call
      // immediately (fire-and-forget, same pattern handleAgentGatherAction
      // uses when a human agent accepts) then drop the AI leg straight
      // into the conference.
      this.logger.log(
        `[agent-twiml] session=${sessionId} skipAgentWhisper=true — bypassing Gather, dropping agent into conference`,
      );
      await this.updateSession(session, { status: SessionStatus.AGENT_ACCEPTED });
      await this.emitEvent(session, WebhookEventType.CALL_CONNECT_AGENT_ACCEPTED);
      this.initiateLeadCall(session).catch((err) => {
        this.logger.error(
          `skip-whisper: lead call failed for session ${session.id}: ${err.message}`,
        );
        this.failSession(session, `Lead call initiation failed: ${err.message}`).catch(() => {});
      });
      const dial = response.dial();
      dial.conference(
        { startConferenceOnEnter: true, endConferenceOnExit: true },
        session.conferenceName,
      );
    } else if (session.mode === CallConnectMode.AGENT_FIRST) {
      const acceptDigits = settings?.agentAcceptDigits || '0123456789';
      // For TTS: "any key" when all digits are in the accept string, otherwise list the digit(s)
      const digitHint = acceptDigits.length > 3 ? 'any key' : acceptDigits;
      // Per-session whisper (pre-built by caller) takes priority over settings template
      const whisperSource: 'session' | 'settings' | 'default' = session.agentWhisperMessage
        ? 'session'
        : settings?.agentWhisperMessage
          ? 'settings'
          : 'default';
      const template =
        session.agentWhisperMessage ||
        settings?.agentWhisperMessage ||
        'New lead for {category}. Customer: {customerName}. Press {digit} to connect.';
      const whisper = this.substituteTemplateVars(template, session, { digit: digitHint });
      this.logger.log(
        `[agent-twiml] session=${sessionId} business=${session.businessId} settingsFound=${!!settings} whisperSource=${whisperSource} whisperLen=${whisper.length}`,
      );

      // 15s is plenty after the whisper; fast-answer detection in handleProviderCallStatus
      // already short-circuits voicemail calls before this TwiML runs.
      const gatherTimeout = Math.min(settings?.ringTimeoutSeconds ?? 20, 15);
      // Pause and whisper are INSIDE the gather so DTMF digits pressed at any
      // point during the message are captured (not lost before gather starts).
      const gather = response.gather({
        numDigits: 1,
        action: `${baseUrl}/api/webhooks/twilio/voice/agent/gather?sessionId=${sessionId}`,
        method: 'POST',
        timeout: gatherTimeout,
      });
      // Audio primer: a short spoken word forces the TTS engine + phone audio
      // channel to fully activate before the real message starts.  A silent
      // <Pause> alone is not enough — some carriers/handsets mute until they
      // detect actual audio, so the first words of the whisper get swallowed.
      gather.pause({ length: 1 });
      gather.say('Attention.');
      gather.pause({ length: 1 });
      gather.say(whisper);
      // Brief pause then repeat instruction so agent doesn't miss it
      gather.pause({ length: 1 });
      gather.say(`Press ${digitHint} to connect.`);

      response.say('No input received. Goodbye.');
      response.hangup();
    } else {
      // PARALLEL: agent joins conference immediately
      const template =
        session.agentWhisperMessage ||
        settings?.agentWhisperMessage ||
        'Connecting you to a new lead: {summary}.';
      const whisper = this.substituteTemplateVars(template, session);
      response.say(whisper);
      const dial = response.dial();
      dial.conference(
        { startConferenceOnEnter: true, endConferenceOnExit: true },
        session.conferenceName,
      );
    }

    const body = response.toString();
    this.logger.log(
      `[agent-twiml-body] session=${sessionId} body=${body.length > 1000 ? body.slice(0, 1000) + '…[truncated]' : body}`,
    );
    return body;
  }

  /**
   * Returns TwiML for the lead leg.
   *
   * When voicemail is enabled the lead call uses `machineDetection: 'Enable'` (sync AMD).
   * Twilio detects the machine early (~3-5s after answer) and POSTs to this URL with
   * `AnsweredBy=machine_start`. This fires BEFORE the voicemail greeting finishes, so the
   * agent notification goes out immediately. A pause in the TwiML allows the voicemail
   * greeting + beep to complete before the message plays.
   * For a human, `AnsweredBy=human` is set quickly and TwiML fires without delay.
   *
   * - human / no answeredBy  → join conference (normal bridge flow)
   * - machine + TTS mode     → notify agent immediately, pause for beep, play message, hang up
   * - machine + SPEAK mode   → redirect the agent to voicemail hold, bridge voicemail to agent
   */
  async handleLeadTwiml(sessionId: string, answeredBy?: string): Promise<string> {
    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session) {
      this.logger.error(`Lead TwiML: session ${sessionId} not found`);
      return this.hangupTwiml();
    }

    const settings = await this.settingsRepo.findOne({
      where: { businessId: session.businessId },
    });

    const isMachine =
      answeredBy === 'machine_start' ||
      answeredBy === 'machine_end_beep' ||
      answeredBy === 'machine_end_silence' ||
      answeredBy === 'machine_end_other' ||
      answeredBy === 'fax';

    if (isMachine && settings?.leadVoicemailEnabled) {
      this.logger.log(
        `Lead TwiML: voicemail detected (${answeredBy}) for session ${sessionId}, mode=${settings.agentVoicemailMode}`,
      );

      if (settings.agentVoicemailMode === AgentVoicemailMode.SPEAK) {
        // SPEAK mode: redirect the agent out of the main conference into the voicemail bridge
        // conference, then bridge the lead's voicemail leg into the same conference.
        const baseUrl = this.getBaseUrl();
        if (session.agentCallSid) {
          this.getTwilioClient(session.businessId, session.tenantId, session.fromNumberE164)
            .then((client) =>
              client.calls(session.agentCallSid!).update({
                url: `${baseUrl}/api/webhooks/twilio/voice/agent/voicemail-hold?sessionId=${sessionId}`,
                method: 'POST',
              }),
            )
            .catch((err) =>
              this.logger.error(
                `Failed to redirect agent to voicemail hold for session ${sessionId}: ${err.message}`,
              ),
            );
        }
        return this.handleLeadVoicemailAgentTwiml(sessionId);
      } else {
        // TTS / recording mode.
        // machineDetection: 'Enable' fires here early (machine_start), before the greeting ends.
        // Notify the agent immediately so they hear it well before the message is sent,
        // then pause ~1s for the voicemail greeting + beep before playing our message.
        const response = new twilio.twiml.VoiceResponse();
        response.pause({ length: 1 });
        if (settings.leadVoicemailRecordingUrl) {
          // Pre-recorded audio takes priority over TTS
          response.play({}, settings.leadVoicemailRecordingUrl);
        } else {
          const vmTemplate =
            settings.leadVoicemailMessage ||
            'Hi, we tried to reach you about an inquiry. Please call us back at your earliest convenience.';
          response.say(this.substituteTemplateVars(vmTemplate, session));
        }
        response.hangup();

        // Emit voicemail_drop event immediately so LeadBridge knows the drop has started.
        // Do NOT set ENDED here — let the completed status callback (fired when the voicemail
        // message finishes and the call hangs up) set ENDED. This means ENDED appears in the
        // timeline AFTER the agent has already heard the notification, not before.
        this.emitEvent(session, WebhookEventType.CALL_CONNECT_VOICEMAIL_DROP, {
          mode: 'tts',
        }).catch(() => {});

        // Notify the agent and hang up their call — they would otherwise be stranded
        // in an empty conference since the lead never fully joined.
        if (session.agentCallSid) {
          const agentNotify = new twilio.twiml.VoiceResponse();
          agentNotify.say('We are sending a voicemail to the customer. Goodbye.');
          agentNotify.hangup();
          this.getTwilioClient(session.businessId, session.tenantId, session.fromNumberE164)
            .then((client) =>
              client.calls(session.agentCallSid!).update({
                twiml: agentNotify.toString(),
              }),
            )
            .catch((err) =>
              this.logger.error(
                `Failed to notify agent of voicemail drop for session ${sessionId}: ${err.message}`,
              ),
            );
        }

        return response.toString();
      }
    }

    // Human answered (or voicemail not enabled): join the conference.
    const baseUrl = this.getBaseUrl();
    const response = new twilio.twiml.VoiceResponse();

    // waitUrl plays the greeting loop while the lead waits for the agent to join.
    const waitUrl = `${baseUrl}/api/webhooks/twilio/voice/lead/wait?sessionId=${sessionId}`;

    // action fires when the conference Dial completes (conference ends for any reason).
    // This keeps the lead call alive so the voicemail-choice flow can redirect it after
    // the agent exits the conference to answer the voicemail-choice prompt.
    const dial = response.dial({
      action: `${baseUrl}/api/webhooks/twilio/voice/lead/after-conference?sessionId=${sessionId}`,
      method: 'POST',
    } as any);

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

    const greetingTemplate = session.leadGreetingMessage || settings?.leadGreetingMessage || 'Please hold while we connect you.';
    const greeting = this.substituteTemplateVars(greetingTemplate, session);
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
  async handleLeadVoicemailTwiml(sessionId: string, answeredBy?: string): Promise<string> {
    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session) return this.hangupTwiml();

    const settings = await this.settingsRepo.findOne({
      where: { businessId: session.businessId },
    });

    const response = new twilio.twiml.VoiceResponse();
    // Pause duration depends on how precisely we know when the beep fired:
    //   machine_end_beep:    0 s — AMD fires exactly at the beep; latency from callback
    //                             → server → REST-redirect → Twilio fetch is ~0.5–1.5 s,
    //                             enough buffer. "Hello. " primer absorbs TTS ramp-up.
    //   hold_loop_fallback:  0 s — hold loop fires after ~1 s; beep has long since passed.
    //   anything else:       1 s — machine_start or unknown fallback.
    if (answeredBy !== 'machine_end_beep' && answeredBy !== 'hold_loop_fallback') {
      response.pause({ length: 1 });
    }

    if (settings?.leadVoicemailRecordingUrl) {
      response.play({}, settings.leadVoicemailRecordingUrl);
    } else {
      // Per-session message (pre-built by caller with variables already substituted) takes
      // priority over the workspace-level template so LeadBridge can send a lead-specific message.
      const vmTemplate =
        session.leadVoicemailMessage ||
        settings?.leadVoicemailMessage ||
        'Hi, we tried to reach you about an inquiry. Please call us back at your earliest convenience.';
      // For machine_end_beep (no pre-pause), voicemail systems often trim the first ~0.5 s of
      // audio — the TTS engine's ramp-up time.  Prepend "Hello. " inside the SAME <Say> verb
      // so there is only one TTS engine startup; the engine ramps up during "Hello." and the
      // real message starts cleanly.  Separate <Say> verbs each have their own startup delay.
      const messageText = this.substituteTemplateVars(vmTemplate, session);
      // Use "Hello. " primer for beep-timed paths (machine_end_beep / hold_loop_fallback)
      // to absorb the ~0.5 s TTS engine ramp-up so the real message starts intact.
      const usesPrimer = answeredBy === 'machine_end_beep' || answeredBy === 'hold_loop_fallback';
      response.say(usesPrimer ? `Hello. ${messageText}` : messageText);
    }

    response.hangup();

    // Session ENDED is set by handleProviderCallStatus when the agent call completes.
    return response.toString();
  }

  /**
   * Called after the lead's conference <Dial> completes (conference ended for any reason).
   *
   * If voicemail is enabled, immediately start the voicemail TwiML on the original lead call
   * in parallel with the agent's choice prompt.  The TwiML plays a 1 s safety pause, then the
   * configured message, then a 10 s post-message pause before hanging up.
   *
   * The 10 s post-message window lets a SPEAK-mode agent REST-redirect the lead call (interrupting
   * the pause) to append a personal message directly into the same voicemail recording.  For
   * automated mode the voicemail system's own silence detection ends the recording naturally;
   * the 10 s timeout hangs up if it does not.
   *
   * If voicemail is disabled (or session is already terminal) hang up immediately.
   */
  async handleLeadAfterConferenceTwiml(sessionId: string): Promise<string> {
    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session || TERMINAL_STATUSES.has(session.status)) return this.hangupTwiml();

    const settings = await this.settingsRepo.findOne({ where: { businessId: session.businessId } });
    if (!settings?.leadVoicemailEnabled) return this.hangupTwiml();

    this.logger.log(
      `After-conference: session=${sessionId} — voicemail enabled, holding lead silently until machine_end_beep fires`,
    );
    const baseUrl = this.getBaseUrl();
    const response = new twilio.twiml.VoiceResponse();
    // Park the lead in a silent hold loop. handleLeadAmd will REST-redirect the lead
    // to /lead/voicemail when machine_end_beep (or machine_end_silence/other) fires,
    // so the message starts at exactly the right moment without a blind pause.
    // If the beep never arrives, the agent's automated-choice path also redirects the lead.
    response.redirect(
      { method: 'POST' },
      `${baseUrl}/api/webhooks/twilio/voice/lead/voicemail-hold?sessionId=${sessionId}`,
    );
    return response.toString();
  }

  /**
   * Silent hold loop for the lead while the agent decides voicemail mode.
   * Pauses briefly then redirects back to itself until the session is terminal
   * (choice made → lead redirected elsewhere) or until the call is cleaned up.
   *
   * If voicemail_triggered is already set in the timeline (the agent's automated-choice
   * path fired and sent a REST-redirect) but this loop is still running (the REST-redirect
   * raced with the natural <Pause> expiry and lost), redirect to the voicemail endpoint here
   * as a fallback so the message is still delivered.
   */
  async handleLeadVoicemailHoldTwiml(sessionId: string): Promise<string> {
    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session) return this.hangupTwiml();

    const voicemailTriggered = (session.timeline || []).some(
      (entry: any) => entry.event === 'voicemail_triggered',
    );

    if (voicemailTriggered) {
      // voicemail_triggered is set (fired by handleLeadAmd or a prior fallback) but the hold
      // loop's <Pause> raced the REST-redirect.  Deliver voicemail now via hold_loop_fallback
      // (adds 2 s compensating pause so TTS doesn't arrive before the beep).
      this.logger.log(
        `Hold loop fallback: voicemail_triggered set for session ${sessionId} — redirecting lead to voicemail`,
      );
      const baseUrl = this.getBaseUrl();
      const response = new twilio.twiml.VoiceResponse();
      response.redirect(
        { method: 'POST' },
        `${baseUrl}/api/webhooks/twilio/voice/lead/voicemail?sessionId=${sessionId}&answeredBy=hold_loop_fallback`,
      );
      return response.toString();
    }

    // Safety net: agent chose automated (automated_chosen flag) but machine_end_beep hasn't
    // arrived within 12 s (AMD may have missed the beep).  Fire the fallback so the message
    // is still delivered rather than the lead hanging up silently.
    const automatedChosenEntry = (session.timeline || []).find(
      (entry: any) => entry.event === 'automated_chosen',
    );
    if (automatedChosenEntry) {
      const elapsedMs = Date.now() - new Date((automatedChosenEntry as any).at).getTime();
      if (elapsedMs > 0) {
        this.logger.log(
          `Hold loop: automated_chosen timeout (${Math.round(elapsedMs / 1000)}s) for session ${sessionId} — firing fallback`,
        );
        session.timeline = [
          ...(session.timeline || []),
          { event: 'voicemail_triggered', at: new Date().toISOString() },
        ];
        await this.sessionRepo.save(session);
        const baseUrl = this.getBaseUrl();
        const response = new twilio.twiml.VoiceResponse();
        response.redirect(
          { method: 'POST' },
          `${baseUrl}/api/webhooks/twilio/voice/lead/voicemail?sessionId=${sessionId}&answeredBy=hold_loop_fallback`,
        );
        return response.toString();
      }
      // Still within timeout — keep looping, machine_end_beep is expected soon.
    }

    // Hang up only when there is no pending automated drop; if automated_chosen is set
    // the lead must stay on the line so machine_end_beep can trigger the voicemail redirect.
    if (TERMINAL_STATUSES.has(session.status) && !automatedChosenEntry) {
      // Fallback: agent hung up before the gather timeout fired (so automated_chosen was
      // never set), but machine_start is in the timeline — redirect to voicemail now so
      // the drop still fires despite the early agent hang-up.
      const timeline = session.timeline || [];
      const machineDetected = timeline.some((e: any) => e.event === 'machine_start');
      const speakInitiated = timeline.some((e: any) => e.event === 'speak_mode_initiated');

      if (machineDetected && !voicemailTriggered && !speakInitiated) {
        this.logger.log(
          `Hold loop fallback: session ${sessionId} is TERMINAL, agent hung up early — redirecting to voicemail`,
        );
        session.timeline = [
          ...timeline,
          { event: 'voicemail_triggered', at: new Date().toISOString() },
        ];
        await this.sessionRepo.save(session);

        const baseUrl = this.getBaseUrl();
        const response = new twilio.twiml.VoiceResponse();
        // Use answeredBy=machine_start so handleLeadVoicemailTwiml applies a 10 s
        // pause before speaking — the beep may not have fired yet at this point.
        response.redirect(
          { method: 'POST' },
          `${baseUrl}/api/webhooks/twilio/voice/lead/voicemail?sessionId=${sessionId}&answeredBy=machine_start`,
        );
        return response.toString();
      }

      return this.hangupTwiml();
    }

    const baseUrl = this.getBaseUrl();
    const response = new twilio.twiml.VoiceResponse();
    response.pause({ length: 1 });
    response.redirect(
      { method: 'POST' },
      `${baseUrl}/api/webhooks/twilio/voice/lead/voicemail-hold?sessionId=${sessionId}`,
    );
    return response.toString();
  }

  /**
   * TwiML presented to the agent when AMD detects the lead's voicemail.
   * Offers a Gather choice: press 1 for personal message, any other key for automated.
   * Gather timeout (no input) falls through to the action with Digits="" → automated.
   */
  async handleAgentVoicemailChoiceTwiml(sessionId: string, answeredBy: string): Promise<string> {
    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session || TERMINAL_STATUSES.has(session.status)) return this.hangupTwiml();

    const baseUrl = this.getBaseUrl();
    const response = new twilio.twiml.VoiceResponse();
    const gather = response.gather({
      numDigits: 1,
      action: `${baseUrl}/api/webhooks/twilio/voice/agent/voicemail-choice-action?sessionId=${sessionId}&answeredBy=${encodeURIComponent(answeredBy)}`,
      method: 'POST',
      timeout: 8,
    });
    gather.pause({ length: 2 });
    gather.say('Voicemail detected. Press 1 to leave a personal message. Press any other key for automated voicemail.');
    // Gather timeout fires the action with Digits="" — handled as automated in choice-action.
    return response.toString();
  }

  /**
   * Handles the agent's voicemail choice (digit pressed or Gather timeout).
   *   digit "1"   → SPEAK mode: REST-redirect the lead call (currently paused in voicemail TwiML)
   *                 to the voicemail-agent TwiML so the lead joins ccvm_<sessionId>; the agent
   *                 TwiML below bridges them so the agent speaks personally into the voicemail.
   *   anything else (including "" on timeout) → automated: the voicemail message is already
   *                 playing on the lead call (started in parallel by handleLeadAfterConferenceTwiml);
   *                 no REST-redirect needed — just say goodbye and hang up the agent.
   */
  async handleAgentVoicemailChoiceAction(
    sessionId: string,
    digits: string,
    answeredBy: string,
  ): Promise<string> {
    const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
    if (!session || TERMINAL_STATUSES.has(session.status)) return this.hangupTwiml();

    const baseUrl = this.getBaseUrl();
    const client = await this.getTwilioClient(session.businessId, session.tenantId, session.fromNumberE164);
    const response = new twilio.twiml.VoiceResponse();

    if (digits === '1') {
      // SPEAK mode — REST-redirect the held lead call (voicemail system) to the voicemail-agent
      // conference TwiML so the lead joins ccvm_<sessionId> with startConferenceOnEnter=true.
      // The agent TwiML below also joins the same conference (startConferenceOnEnter=false),
      // bridging them so the agent speaks their personal message directly into the voicemail.
      this.logger.log(`Voicemail SPEAK chosen for session ${sessionId} — redirecting held lead call`);

      // Mark SPEAK as initiated BEFORE the REST call so that machine_end_beep (which may
      // fire concurrently) sees the flag and skips the automated redirect.
      session.timeline = [
        ...(session.timeline || []),
        { event: 'speak_mode_initiated', at: new Date().toISOString() },
      ];
      await this.sessionRepo.save(session);

      this.emitEvent(session, WebhookEventType.CALL_CONNECT_VOICEMAIL_DROP, { mode: 'speak' }).catch(() => {});
      if (session.leadCallSid) {
        await client.calls(session.leadCallSid).update({
          url: `${baseUrl}/api/webhooks/twilio/voice/lead/voicemail-agent?sessionId=${sessionId}`,
          method: 'POST',
        }).catch((err: any) =>
          this.logger.warn(`Could not redirect lead to voicemail-agent for session ${sessionId}: ${err.message}`),
        );
      }
      response.say('Connected. Leave your message after the beep, then hang up.');
      const dial = response.dial();
      dial.conference(
        { startConferenceOnEnter: false, endConferenceOnExit: true } as any,
        `ccvm_${sessionId}`,
      );
    } else {
      // Automated drop — the lead is in the silent hold loop waiting for machine_end_beep.
      // machine_end_beep may have already fired and set voicemail_triggered, or it may
      // fire shortly after.
      this.logger.log(`Voicemail automated chosen for session ${sessionId} (digits="${digits}")`);

      const alreadyTriggered = (session.timeline || []).some(
        (entry: any) => entry.event === 'voicemail_triggered',
      );

      if (!alreadyTriggered) {
        // machine_end_beep has NOT fired yet.
        // Do NOT REST-redirect the lead now — the answering machine's greeting may still be
        // playing, so TTS starting immediately would miss the first words (the machine only
        // records after the beep).  Instead, mark automated_chosen so that:
        //   • handleLeadAmd() will redirect the lead when machine_end_beep fires at the
        //     exact beep moment (0 s pause + "Hello." primer, perfect timing), and
        //   • the hold-loop safety net below fires a fallback if the beep never arrives.
        // This mirrors SPEAK mode: the lead stays on hold until the right moment, then
        // the message plays — agent's voice for SPEAK, TTS for automated.
        session.timeline = [
          ...(session.timeline || []),
          { event: 'automated_chosen', at: new Date().toISOString() },
        ];
        await this.sessionRepo.save(session);

        // Notify LeadBridge that the agent chose automated voicemail.
        this.emitEvent(session, WebhookEventType.CALL_CONNECT_VOICEMAIL_DROP, { mode: 'tts' }).catch(() => {});
      } else {
        this.logger.log(
          `Session ${sessionId}: voicemail_triggered already set — machine_end_beep handled the redirect`,
        );
        // Still notify LeadBridge (machine_end_beep handler doesn't emit this event)
        this.emitEvent(session, WebhookEventType.CALL_CONNECT_VOICEMAIL_DROP, { mode: 'tts' }).catch(() => {});
      }

      response.say('Automated message will be sent. Goodbye.');
      response.hangup();
    }

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
    const acceptDigits = settings?.agentAcceptDigits || '0123456789';

    if (acceptDigits.includes(digits)) {
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
      // Agent explicitly declined — fail immediately, no retries
      this.logger.log(`Agent declined call for session ${session.id} (digit=${digits}, acceptDigits=${acceptDigits})`);
      await this.failSession(session, 'Agent declined');
      return this.hangupTwiml();
    }
  }

  /**
   * Handles the async Answering Machine Detection (AMD) callback from Twilio.
   * If voicemail is detected on the agent's phone, fail immediately and hang up both calls.
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

    // Fail immediately — failSession hangs up both agent and lead calls
    await this.failSession(session, `Agent voicemail detected (${answeredBy})`);
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
    if (!session) return;

    // For machine_end_beep: allow through even if the session is ENDED.
    // This happens when the agent chose automated voicemail, their call completed (→ ENDED),
    // and machine_end_beep fires afterward.  We still need to REST-redirect the lead.
    if (TERMINAL_STATUSES.has(session.status)) {
      const isEndBeep = answeredBy !== 'machine_start';
      if (!isEndBeep) return; // machine_start on a terminal session → nothing to do
      const timeline = session.timeline || [];
      const automatedChosen = timeline.some((e: any) => e.event === 'automated_chosen');
      const voicemailTriggered = timeline.some((e: any) => e.event === 'voicemail_triggered');
      if (!automatedChosen || voicemailTriggered) return; // no pending automated drop → skip
      // Fall through: automated drop is pending, deliver it despite ENDED status
    }

    const settings = await this.settingsRepo.findOne({
      where: { businessId: session.businessId },
    });

    if (!settings?.leadVoicemailEnabled) {
      // Voicemail drop disabled — hang up lead and fail session (only act on machine_start
      // to avoid double-failing if machine_end fires later for the same call)
      if (answeredBy === 'machine_start') {
        try {
          const client = await this.getTwilioClient(session.businessId, session.tenantId, session.fromNumberE164);
          await client.calls(callSid).update({ status: 'completed' }).catch(() => {});
        } catch {}
        await this.failSession(session, `Lead voicemail detected but drop disabled (${answeredBy})`);
      }
      return;
    }

    const baseUrl = this.getBaseUrl();
    const client = await this.getTwilioClient(session.businessId, session.tenantId, session.fromNumberE164);

    if (answeredBy === 'machine_start') {
      // Early AMD detection — greeting is still playing.
      // Offer the agent a choice: leave a personal message (press 1) or automated drop.
      // Redirecting the agent out of the conference ends the conference; the lead's
      // <Dial action="/lead/after-conference"> then parks the lead in the silent hold loop
      // until machine_end_beep fires below.

      // Record machine detection in timeline so the hold loop can use it as a fallback
      // signal (e.g. if the agent hangs up early without triggering voicemail).
      session.timeline = [
        ...(session.timeline || []),
        { event: 'machine_start', at: new Date().toISOString() },
      ];
      await this.sessionRepo.save(session);

      if (session.agentCallSid) {
        await client.calls(session.agentCallSid).update({
          url: `${baseUrl}/api/webhooks/twilio/voice/agent/voicemail-choice?sessionId=${sessionId}&answeredBy=${encodeURIComponent(answeredBy)}`,
          method: 'POST',
        }).catch((err: any) => {
          this.logger.warn(`Could not redirect agent to voicemail choice for session ${sessionId}: ${err.message}`);
        });
      }
      this.logger.log(`Voicemail choice offered to agent for session ${sessionId} (${answeredBy})`);
    } else {
      // machine_end_beep / machine_end_silence / machine_end_other / fax:
      // The beep has fired (or the recording window has opened). REST-redirect the lead
      // from the silent hold loop to voicemail TwiML immediately — no pre-message pause needed.

      // Guard: if agent already chose SPEAK (press 1), skip — SPEAK path handles the redirect.
      const speakInitiated = (session.timeline || []).some(
        (entry: any) => entry.event === 'speak_mode_initiated',
      );
      if (speakInitiated) {
        this.logger.log(
          `Lead AMD ${answeredBy} for session ${sessionId} — speak_mode_initiated, skipping automated redirect`,
        );
        return;
      }

      // Guard: prevent double-trigger if the agent's automated-choice path already fired.
      const alreadyTriggered = (session.timeline || []).some(
        (entry: any) => entry.event === 'voicemail_triggered',
      );
      if (alreadyTriggered) {
        this.logger.log(
          `Lead AMD ${answeredBy} for session ${sessionId} — voicemail_triggered already set, skipping`,
        );
        return;
      }

      // Mark as triggered before the REST call to minimise the race window.
      session.timeline = [
        ...(session.timeline || []),
        { event: 'voicemail_triggered', at: new Date().toISOString() },
      ];
      await this.sessionRepo.save(session);

      if (session.leadCallSid) {
        await client.calls(session.leadCallSid).update({
          url: `${baseUrl}/api/webhooks/twilio/voice/lead/voicemail?sessionId=${sessionId}&answeredBy=${encodeURIComponent(answeredBy)}`,
          method: 'POST',
        }).catch((err: any) => {
          this.logger.warn(
            `Could not redirect lead to voicemail TwiML for session ${sessionId}: ${err.message}`,
          );
        });
      }

      this.logger.log(
        `Lead REST-redirected to voicemail TwiML for session ${sessionId} (${answeredBy})`,
      );
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
          await this.emitEvent(session, WebhookEventType.CALL_CONNECT_AGENT_RINGING);
          // PARALLEL: wait for lead to also answer before marking BRIDGED
        } else if (isLeadLeg && session.status !== SessionStatus.BRIDGED) {
          await this.updateSession(session, { status: SessionStatus.LEAD_ANSWERED });
          await this.updateSession(session, { status: SessionStatus.BRIDGED });
          await this.emitEvent(session, WebhookEventType.CALL_CONNECT_BRIDGED);
        }
        break;

      case 'completed':
        if (session.status === SessionStatus.BRIDGED && isAgentLeg) {
          // Agent leg ended (normal call end or voicemail choice goodbye).
          // This is the authoritative signal that the session is truly over.
          const updates: Partial<CallConnectSession> = { status: SessionStatus.ENDED };
          if (callDuration) {
            updates.timeline = [
              ...session.timeline,
              { event: 'ended', callSid, duration: parseInt(callDuration), at: new Date().toISOString() },
            ];
          }
          await this.updateSession(session, updates);
          await this.emitEvent(session, WebhookEventType.CALL_CONNECT_ENDED);
        } else if (session.status === SessionStatus.BRIDGED && isLeadLeg) {
          // Lead leg completed while session is BRIDGED.  Two scenarios reach here:
          //   A) Normal call end: lead hung up, conference ends; agent will complete
          //      momentarily via endConferenceOnExit → ENDED will be set then.
          //   B) Voicemail AMD flow: handleLeadAfterConferenceTwiml hung up the original
          //      lead call; agent is still alive on the voicemail-choice prompt.
          // In both cases, defer ENDED to the agent leg completion above.
          // Do NOT set ENDED here — that would prematurely terminate the session and
          // cause handleAgentVoicemailChoiceAction to return hangupTwiml() for the agent.
          this.logger.log(
            `Session ${session.id}: lead leg completed while BRIDGED — deferring ENDED to agent completion`,
          );
        } else if (isAgentLeg && session.status === SessionStatus.CALLING_AGENT) {
          // Call ended before the agent answered (voicemail, hung up, etc.)
          // Fail immediately — no retries. failSession hangs up the lead call too.
          this.logger.log(`Session ${session.id}: agent call completed before answering`);
          await this.failSession(session, 'Agent call ended before answer');
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
            // Agent didn't pick up or declined — fail immediately, no retries
            await this.failSession(session, `Agent ${callStatus}`);
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
          // Lead didn't answer (no-answer) or declined (busy/failed/canceled).
          // Always disconnect the agent — there is nothing for them to do when the lead
          // never picked up. failSession hangs up both legs via Twilio REST.
          const reason = settings?.leadVoicemailEnabled
            ? `Lead ${callStatus} — no voicemail engaged`
            : `Lead ${callStatus}`;
          await this.failSession(session, reason);
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

  /**
   * Attach a Twilio recording URL to whichever session owns the CallSid, then
   * emit a call_connect.ended event carrying `recordingUrl` so downstream
   * subscribers (LeadBridge) can populate `LeadCallConnect.recordingUrl` and
   * light up the "Listen to recording" link on the lead detail card.
   *
   * Called by TwilioWebhooksService.handleRecordingComplete after it saves
   * the URL on the sibling `CommunicationCall` row. That save (call.recordingUrl)
   * is orthogonal — the Call entity is queried by conversations UI; the session's
   * recordingUrl is what LeadBridge cares about.
   *
   * The CallSid can belong to either leg (agent or lead) — search both.
   * Silent no-op if no matching session (recording is for a non-CC call, e.g.
   * an inbound voicemail via the forwarding number).
   */
  async attachRecordingToSession(callSid: string, recordingUrl: string): Promise<void> {
    if (!callSid || !recordingUrl) return;
    const session = await this.sessionRepo.findOne({
      where: [{ agentCallSid: callSid }, { leadCallSid: callSid }],
    });
    if (!session) return; // recording is for something other than a CC session

    // Prefer the agent-leg recording since that's the one the whisper + bridged
    // conversation gets recorded on. If we already have a recording (e.g. the
    // lead leg fired first for some reason), don't overwrite.
    if (session.recordingUrl) {
      this.logger.log(
        `[attachRecording] Session ${session.id} already has recordingUrl — skipping (incoming ${callSid})`,
      );
      return;
    }

    session.recordingUrl = recordingUrl;
    await this.sessionRepo.save(session);
    this.logger.log(`[attachRecording] Session ${session.id} recordingUrl set from CallSid ${callSid}`);

    // Emit a second call_connect.ended event carrying the recordingUrl so LB
    // updates LeadCallConnect.recordingUrl. Reusing the existing event type
    // avoids needing every existing subscription to be re-registered with a new
    // event — LB's handleWebhookEvent is idempotent on repeated ended events
    // (status stays ENDED, timeline gets one extra entry, recordingUrl written).
    await this.emitEvent(session, WebhookEventType.CALL_CONNECT_ENDED, { recordingUrl });
  }

  /**
   * Fetch the Whisper transcription for a Call Connect session, generating
   * it on demand from the cached Twilio recording. Cached on the session
   * row after first successful generation.
   *
   * Called by consumers (LB `syncLeadCallConnectTranscripts`) that want to
   * feed the transcript into their own summarizer. Sigcore does NOT
   * summarize on this side — the summary format lives with the consumer.
   *
   * Returns { transcript: null, status: 'absent' } when:
   *   - session has no recording (never captured / short call)
   *   - OpenAI is not configured on Sigcore
   * Returns { transcript: null, status: 'error' } on any transient failure
   * (Twilio download 5xx, Whisper 5xx) so the consumer can retry on next
   * hydrate without a stored empty string that would suppress future tries.
   */
  async getOrGenerateTranscript(
    workspaceId: string,
    sessionId: string,
  ): Promise<{ transcript: string | null; status: 'completed' | 'absent' | 'error' }> {
    const session = await this.sessionRepo.findOne({
      where: { id: sessionId, businessId: workspaceId },
    });
    if (!session) throw new NotFoundException(`Session ${sessionId} not found`);

    if (session.transcript && session.transcript.trim().length > 0) {
      return { transcript: session.transcript, status: 'completed' };
    }
    if (!session.recordingUrl) {
      return { transcript: null, status: 'absent' };
    }
    if (!this.openai) {
      this.logger.warn(
        `[transcribe] OPENAI_API_KEY not configured — cannot generate transcript for session ${sessionId}`,
      );
      return { transcript: null, status: 'error' };
    }

    try {
      // Resolve Twilio credentials for this session so we can basic-auth
      // download the recording MP3 — Twilio recording URLs are only
      // accessible with the account's SID:token pair. Reuse the same
      // Twilio account selection the outbound legs used so the recording
      // ownership matches (subaccount vs master handled by resolver).
      const sel = await this.resolveTwilioSelection(
        session.businessId,
        session.tenantId ?? undefined,
        session.fromNumberE164,
      );

      // Sigcore's resolveTwilioSelection intentionally does NOT return
      // the auth token — we need the raw credentials for the audio HTTP
      // download since Twilio's REST client doesn't expose the recording
      // bytes directly. Load the integration and decrypt inline; do NOT
      // log the token.
      const integration = await this.integrationRepo.findOne({
        where: { id: sel.integrationId },
      });
      if (!integration?.credentialsEncrypted) {
        this.logger.error(
          `[transcribe] Session ${sessionId} — integration ${sel.integrationId} has no credentials`,
        );
        return { transcript: null, status: 'error' };
      }
      const twilioCreds = JSON.parse(
        this.encryptionService.decrypt(integration.credentialsEncrypted),
      ) as { accountSid: string; authToken: string };

      // Twilio recording URL comes without a media extension; append .mp3
      // to get the audio payload (WAV would be `.wav`). Use `mp3` because
      // Whisper handles it well and the payload is much smaller than WAV.
      const audioUrl = session.recordingUrl.endsWith('.mp3')
        ? session.recordingUrl
        : `${session.recordingUrl}.mp3`;
      const basicAuth = Buffer.from(
        `${twilioCreds.accountSid}:${twilioCreds.authToken}`,
      ).toString('base64');

      this.logger.log(
        `[transcribe] Session ${sessionId} — fetching Twilio recording (${audioUrl.slice(-40)})`,
      );
      const audioResp = await fetch(audioUrl, {
        headers: { Authorization: `Basic ${basicAuth}` },
      });
      if (!audioResp.ok) {
        this.logger.error(
          `[transcribe] Session ${sessionId} — Twilio recording download ${audioResp.status}`,
        );
        return { transcript: null, status: 'error' };
      }
      const audioBuffer = Buffer.from(await audioResp.arrayBuffer());

      this.logger.log(
        `[transcribe] Session ${sessionId} — Whisper transcribing ${audioBuffer.length} bytes`,
      );
      const file = await toFile(audioBuffer, `${sessionId}.mp3`, {
        type: 'audio/mpeg',
      });
      const result = await this.openai.audio.transcriptions.create({
        model: 'whisper-1',
        file,
        response_format: 'text',
      });
      const text =
        typeof result === 'string'
          ? result
          : (result as { text?: string })?.text ?? '';
      const trimmed = text.trim();
      if (trimmed.length === 0) {
        this.logger.warn(
          `[transcribe] Session ${sessionId} — Whisper returned empty transcript`,
        );
        return { transcript: null, status: 'error' };
      }

      session.transcript = trimmed;
      await this.sessionRepo.save(session);
      this.logger.log(
        `[transcribe] Session ${sessionId} — cached ${trimmed.length} chars`,
      );
      return { transcript: trimmed, status: 'completed' };
    } catch (err: any) {
      this.logger.error(
        `[transcribe] Session ${sessionId} — failed: ${err?.message ?? err}`,
      );
      return { transcript: null, status: 'error' };
    }
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
    const selection = await this.selectTwilioClientForLeg(session, 'agent');
    const baseUrl = this.getBaseUrl();

    this.logger.log(
      `AGENT_FIRST: calling agent ${session.agentPhoneE164} for session ${session.id}`,
    );

    // No machineDetection: it caused ~6s silence on pickup (sync AMD delayed TwiML).
    // Agent voicemail is handled naturally: carrier voicemail → no-answer → tryNextAgentOrFail.
    const callParams: Record<string, unknown> = {
      to: session.agentPhoneE164,
      from: session.fromNumberE164,
      url: `${baseUrl}/api/webhooks/twilio/voice/agent?sessionId=${session.id}`,
      statusCallback: `${baseUrl}/api/webhooks/twilio/voice/status`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      timeout: settings.ringTimeoutSeconds,
    };
    // Record the agent leg when requested (test calls) so we can hear the whisper
    if (session.recordAgentLeg) {
      (callParams as any).record = true;
      (callParams as any).recordingStatusCallback = `${baseUrl}/api/webhooks/twilio/recording-status`;
      this.logger.log(`[AGENT_FIRST] Recording agent leg for session ${session.id}`);
    }
    const call = await this.createLegCall(selection, session, 'agent', callParams);

    await this.updateSession(session, {
      status: SessionStatus.CALLING_AGENT,
      agentCallSid: call.sid,
    });

    this.logger.log(`[agent-call-sid] session=${session.id} agentCallSid=${call.sid}`);
  }

  private async startParallelMode(
    session: CallConnectSession,
    settings: CallConnectSettings,
  ): Promise<void> {
    // Both legs use the same selected integration + share `session.fromNumberE164`.
    // Resolve once, look up the phone-integration once, log per-leg.
    const selection = await this.resolveTwilioSelection(
      session.businessId,
      session.tenantId,
      session.fromNumberE164,
    );
    selection.selectedPhoneIntegrationId = await this.lookupPhoneIntegrationId(
      session.businessId,
      session.fromNumberE164,
    );
    this.emitSelectionLog(selection, session, 'agent');
    this.emitSelectionLog(selection, session, 'lead');
    const baseUrl = this.getBaseUrl();

    this.logger.log(
      `PARALLEL: calling agent ${session.agentPhoneE164} and lead ${session.leadPhoneE164} for session ${session.id}`,
    );

    const [agentCall, leadCall] = await Promise.all([
      this.createLegCall(selection, session, 'agent', {
        to: session.agentPhoneE164,
        from: session.fromNumberE164,
        url: `${baseUrl}/api/webhooks/twilio/voice/agent?sessionId=${session.id}`,
        statusCallback: `${baseUrl}/api/webhooks/twilio/voice/status`,
        statusCallbackMethod: 'POST',
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        timeout: settings.ringTimeoutSeconds,
      }),
      this.createLegCall(selection, session, 'lead', {
        to: session.leadPhoneE164,
        from: session.fromNumberE164,
        url: `${baseUrl}/api/webhooks/twilio/voice/lead?sessionId=${session.id}`,
        statusCallback: `${baseUrl}/api/webhooks/twilio/voice/status`,
        statusCallbackMethod: 'POST',
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        // Always use 60s: carriers take up to 25-30s to forward to voicemail.
        // Whether voicemail is ON (AMD drop) or OFF (agent speaks personally), 60s
        // ensures the carrier has time to route the call before we time out.
        timeout: 60,
        // Async AMD: TwiML URL fires immediately on answer (no ~6s queue delay from sync AMD).
        // AMD result arrives asynchronously at /lead/amd — handleLeadAmd() redirects the call
        // to the voicemail drop TwiML if a machine is detected.
        ...(settings.leadVoicemailEnabled
          ? {
              machineDetection: 'Enable',
              asyncAmd: 'true',
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
      `[agent-call-sid] session=${session.id} agentCallSid=${agentCall.sid} leadCallSid=${leadCall.sid}`,
    );
  }

  private async initiateLeadCall(session: CallConnectSession): Promise<void> {
    const selection = await this.selectTwilioClientForLeg(session, 'lead');
    const baseUrl = this.getBaseUrl();
    const settings = await this.settingsRepo.findOne({
      where: { businessId: session.businessId },
    });

    this.logger.log(
      `Initiating lead call ${session.leadPhoneE164} for session ${session.id}`,
    );

    const leadCall = await this.createLegCall(selection, session, 'lead', {
      to: session.leadPhoneE164,
      from: session.fromNumberE164,
      url: `${baseUrl}/api/webhooks/twilio/voice/lead?sessionId=${session.id}`,
      statusCallback: `${baseUrl}/api/webhooks/twilio/voice/status`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      // Always use 60s: if voicemail is ON, AMD needs time to detect the machine.
      // If voicemail is OFF, the carrier may still forward to the lead's voicemail so the
      // agent can speak personally — we need 60s to allow that forwarding to happen.
      timeout: 60,
      // Async AMD: TwiML URL fires immediately on answer (no ~6s queue delay from sync AMD).
      // AMD result arrives asynchronously at /lead/amd — handleLeadAmd() redirects the call
      // to the voicemail drop TwiML if a machine is detected.
      ...(settings?.leadVoicemailEnabled
        ? {
            machineDetection: 'Enable',
            asyncAmd: 'true',
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
      const client = await this.getTwilioClient(session.businessId, session.tenantId, session.fromNumberE164);
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
      const selection = await this.selectTwilioClientForLeg(session, 'voicemail_drop');
      const client = selection.client;

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

      await this.createLegCall(selection, session, 'voicemail_drop', {
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
        const client = await this.getTwilioClient(session.businessId, session.tenantId, session.fromNumberE164);
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
      await this.outboundWebhooks.emitEvent(
        session.businessId,
        eventType,
        {
          sessionId: session.id,
          leadId: session.leadId,
          businessId: session.businessId,
          sigcoreConversationId: session.sigcoreConversationId ?? null,
          status: session.status,
          mode: session.mode,
          agentPhone: session.agentPhoneE164,
          leadPhone: session.leadPhoneE164,
          attempt: session.attempt,
          updatedAt: new Date().toISOString(),
          ...extra,
        },
        session.tenantId || undefined,
      );
    } catch (err: any) {
      this.logger.error(`Failed to emit ${eventType} for session ${session.id}: ${err.message}`);
    }
  }

  private async getTwilioClient(
    workspaceId: string,
    tenantId?: string,
    /**
     * Incident 2026-07-14 Phase 3a — E.164 caller-ID / bot number. When
     * supplied, `ProviderContextResolver` keys off the TPN via rule 1
     * (`by_number`) — the canonical resolution path. Left optional so the
     * one existing tenant-scoped path above and pre-Phase-3a callers that
     * pass workspaceId only keep working.
     */
    fromNumber?: string,
  ): Promise<twilio.Twilio> {
    const sel = await this.resolveTwilioSelection(workspaceId, tenantId, fromNumber);
    return sel.client;
  }

  /**
   * Diagnostic-only resolution used at outbound-leg creation sites (2026-07-14
   * incident). Same resolution rules as `getTwilioClient` — DB reads are
   * identical — but returns the picked integration id, selection source
   * (tenant vs workspace), account SID, and subaccount SID alongside the
   * Twilio client so the caller can emit one
   * `call_connect_twilio_client_selected` telemetry event per leg and, on
   * `client.calls.create` failure, attribute the failure to the exact row
   * that was picked. Never returns the auth token to the caller.
   */
  private async resolveTwilioSelection(
    workspaceId: string,
    tenantId?: string,
    fromNumber?: string,
  ): Promise<TwilioLegSelection> {
    // 1. Try tenant-level integration first (tenant-provisioned Twilio account).
    // Kept as-is: tenant_integrations is the per-tenant provisioning table and
    // this table is intentionally NOT what the resolver consults.
    if (tenantId) {
      const tenantIntegration = await this.tenantIntegrationRepo.findOne({
        where: { workspaceId, tenantId, provider: ProviderType.TWILIO },
      });
      if (tenantIntegration?.credentialsEncrypted) {
        const credentials = JSON.parse(
          this.encryptionService.decrypt(tenantIntegration.credentialsEncrypted),
        );
        return {
          client: twilio(credentials.accountSid, credentials.authToken),
          integrationId: tenantIntegration.id,
          selectionSource: 'tenant',
          providerAccountSid: credentials.accountSid,
          // TenantIntegration does not carry a subaccount SID column; the
          // account SID above IS the account credentials are bound to.
          providerSubaccountSid: null,
          // Populated later by `selectTwilioClientForLeg` from the caller's
          // fromNumber; this method has no fromNumber context.
          selectedPhoneIntegrationId: null,
        };
      }
    }

    // 2. Workspace-level lookup — use the deterministic resolver when it's
    // wired. Passes the session's fromNumber so rule 1 (by_number) can pick
    // the correct integration in workspaces that host more than one Twilio
    // account. Falls back to the pre-Phase-3a workspace lookup when the
    // resolver isn't wired (test builders) or when the resolver reports
    // NotFound — preserving the existing thrown-Error surface on genuine
    // config gaps. Security-critical resolver errors (403 cross-tenant /
    // 409 ambiguous / 409 provider mismatch) MUST propagate.
    let integration: CommunicationIntegration | null = null;
    if (this.providerContextResolver) {
      try {
        const ctx = await this.providerContextResolver.resolve({
          workspaceId,
          tenantId: tenantId || undefined,
          provider: ProviderType.TWILIO,
          fromNumber: fromNumber || undefined,
        });
        integration = ctx.integration;
      } catch (err) {
        if (!(err instanceof NotFoundException)) {
          throw err;
        }
      }
    }
    if (!integration) {
      integration = await this.integrationRepo.findOne({
        where: { workspaceId, provider: ProviderType.TWILIO },
      });
    }

    if (!integration?.credentialsEncrypted) {
      throw new Error(
        `No Twilio integration found for workspace ${workspaceId}${tenantId ? ` / tenant ${tenantId}` : ''}`,
      );
    }

    const credentials = JSON.parse(
      this.encryptionService.decrypt(integration.credentialsEncrypted),
    );

    return {
      client: twilio(credentials.accountSid, credentials.authToken),
      integrationId: integration.id,
      selectionSource: 'workspace',
      providerAccountSid: credentials.accountSid,
      // 6B.5A: populated when a subaccount was minted for this workspace;
      // NULL for grandfathered pilot/master-account rows.
      providerSubaccountSid: integration.providerSubaccountSid ?? null,
      // Populated later by `selectTwilioClientForLeg` from the caller's
      // fromNumber; this method has no fromNumber context.
      selectedPhoneIntegrationId: null,
    };
  }

  /**
   * Look up the integration id that owns `fromNumber` per our own
   * `tenant_phone_numbers` record. Returns `null` when the TPN row does
   * not exist or `metadata.integrationId` is not populated (the common
   * case today — no provisioning path writes this field yet). Written
   * this way so the From-aware lookup lands transparently once the
   * schema/backfill is in place.
   */
  private async lookupPhoneIntegrationId(
    workspaceId: string,
    fromNumber: string,
  ): Promise<string | null> {
    try {
      const tpn = await this.tenantPhoneRepo.findOne({
        where: { workspaceId, phoneNumber: fromNumber },
      });
      const meta = tpn?.metadata as Record<string, unknown> | undefined;
      const id = meta && typeof meta.integrationId === 'string' ? meta.integrationId : null;
      return id;
    } catch (err: any) {
      this.logger.warn(
        `call_connect_twilio_phone_integration_lookup_error workspaceId=${workspaceId} fromNumber=${this.maskPhone(fromNumber)} error=${(err?.message ?? String(err)).slice(0, 200).replace(/\s+/g, ' ')}`,
      );
      return null;
    }
  }

  /**
   * Resolve the Twilio client for an outbound leg AND emit one
   * `call_connect_twilio_client_selected` telemetry line. Callers that
   * subsequently invoke `client.calls.create(...)` should use
   * `createLegCall(selection, session, leg, params)` to get failure
   * telemetry with matching selection context.
   */
  private async selectTwilioClientForLeg(
    session: CallConnectSession,
    leg: 'agent' | 'lead' | 'voicemail_drop',
  ): Promise<TwilioLegSelection> {
    const sel = await this.resolveTwilioSelection(
      session.businessId,
      session.tenantId,
      session.fromNumberE164,
    );
    sel.selectedPhoneIntegrationId = await this.lookupPhoneIntegrationId(
      session.businessId,
      session.fromNumberE164,
    );
    this.emitSelectionLog(sel, session, leg);
    return sel;
  }

  /**
   * Emit the `call_connect_twilio_client_selected` telemetry line. Split
   * out from `selectTwilioClientForLeg` so PARALLEL mode can resolve once
   * and log per-leg without redundant DB reads.
   */
  private emitSelectionLog(
    sel: TwilioLegSelection,
    session: CallConnectSession,
    leg: 'agent' | 'lead' | 'voicemail_drop',
  ): void {
    this.logger.log(
      `call_connect_twilio_client_selected ` +
        `sessionId=${session.id} ` +
        `workspaceId=${session.businessId} ` +
        `tenantId=${session.tenantId ?? 'none'} ` +
        `integrationId=${sel.integrationId} ` +
        `selectionSource=${sel.selectionSource} ` +
        `providerAccountSid=${this.maskAccountSid(sel.providerAccountSid)} ` +
        `providerSubaccountSid=${sel.providerSubaccountSid ? this.maskAccountSid(sel.providerSubaccountSid) : 'none'} ` +
        `fromNumber=${this.maskPhone(session.fromNumberE164)} ` +
        `selectedPhoneIntegrationId=${sel.selectedPhoneIntegrationId ?? 'none'} ` +
        `leg=${leg}`,
    );
  }

  /**
   * Wrap `client.calls.create(params)` for an outbound leg. On any Twilio
   * failure, emit `call_connect_twilio_create_failed` with the selection
   * context and Twilio's error code + message, then re-throw so existing
   * exception handling (`initiateMode` catch → `failSession`) is unchanged.
   *
   * When `CALL_CONNECT_DIAG_OWNERSHIP=true`, additionally run a read-only
   * `incomingPhoneNumbers.list({ phoneNumber })` probe against the selected
   * account to record whether the picked account actually owns the From-
   * number. Env-gated because it adds one Twilio round-trip per failure —
   * safe to leave off outside an active incident.
   */
  private async createLegCall(
    selection: TwilioLegSelection,
    session: CallConnectSession,
    leg: 'agent' | 'lead' | 'voicemail_drop',
    params: Record<string, unknown>,
  ): Promise<any> {
    try {
      return await selection.client.calls.create(params as any);
    } catch (err: any) {
      const twilioErrorCode =
        err?.code !== undefined && err?.code !== null ? String(err.code) : 'unknown';
      const twilioErrorMessage = (err?.message ?? String(err))
        .slice(0, 200)
        .replace(/\s+/g, ' ');
      const toNumber = typeof params.to === 'string' ? params.to : undefined;
      this.logger.warn(
        `call_connect_twilio_create_failed ` +
          `sessionId=${session.id} ` +
          `leg=${leg} ` +
          `workspaceId=${session.businessId} ` +
          `tenantId=${session.tenantId ?? 'none'} ` +
          `integrationId=${selection.integrationId} ` +
          `selectionSource=${selection.selectionSource} ` +
          `providerAccountSid=${this.maskAccountSid(selection.providerAccountSid)} ` +
          `providerSubaccountSid=${selection.providerSubaccountSid ? this.maskAccountSid(selection.providerSubaccountSid) : 'none'} ` +
          `fromNumber=${this.maskPhone(session.fromNumberE164)} ` +
          `selectedPhoneIntegrationId=${selection.selectedPhoneIntegrationId ?? 'none'} ` +
          `toNumberMasked=${this.maskPhone(toNumber)} ` +
          `twilioErrorCode=${twilioErrorCode} ` +
          `twilioErrorMessage=${twilioErrorMessage}`,
      );

      if (this.config.get<string>('CALL_CONNECT_DIAG_OWNERSHIP') === 'true') {
        try {
          const matches = await selection.client.incomingPhoneNumbers.list({
            phoneNumber: session.fromNumberE164,
            limit: 1,
          });
          this.logger.warn(
            `call_connect_twilio_ownership_check ` +
              `sessionId=${session.id} ` +
              `providerAccountSid=${this.maskAccountSid(selection.providerAccountSid)} ` +
              `fromNumber=${this.maskPhone(session.fromNumberE164)} ` +
              `selectedAccountOwnsFromNumber=${matches.length > 0}`,
          );
        } catch (probeErr: any) {
          this.logger.warn(
            `call_connect_twilio_ownership_check_error ` +
              `sessionId=${session.id} ` +
              `error=${(probeErr?.message ?? String(probeErr)).slice(0, 200).replace(/\s+/g, ' ')}`,
          );
        }
      }

      throw err;
    }
  }

  /**
   * Mask an E.164 phone number for logs: keeps country + first 3 digits
   * and last 4, replaces the middle with `***`. Non-E.164 or short inputs
   * collapse to `***` / `unknown`.
   */
  private maskPhone(e164?: string | null): string {
    if (!e164) return 'unknown';
    if (e164.length < 8) return '***';
    return `${e164.slice(0, 5)}***${e164.slice(-4)}`;
  }

  /**
   * Mask a Twilio Account SID (`AC...`) or Subaccount SID for logs. Keeps
   * enough prefix to distinguish master from subaccount families and
   * enough suffix to disambiguate two accounts with the same prefix.
   */
  private maskAccountSid(sid?: string | null): string {
    if (!sid) return 'unknown';
    if (sid.length <= 10) return sid;
    return `${sid.slice(0, 6)}…${sid.slice(-4)}`;
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

  /**
   * Substitutes template variables in a message string.
   * Supported: {summary}, {customerName}, {category}, {location}, {digit}
   * Parses leadSummary using the "Name — Category — Location" format.
   */
  private substituteTemplateVars(
    template: string,
    session: CallConnectSession,
    extra?: { digit?: string },
  ): string {
    const summary = session.leadSummary || '';
    // Accept both em-dash (—) and en-dash (–) as separators; LeadBridge uses en-dash.
    const parts = summary.split(/\s*[—–]\s*/);
    const customerName = parts[0]?.trim() || summary;
    const category = parts[1]?.trim() || '';
    const location = parts[2]?.trim() || '';
    const digitHint = extra?.digit ?? '';
    const phone = session.leadPhoneE164 || '';

    return template
      .replace(/\{summary\}/g, summary)
      .replace(/\{customerName\}/g, customerName)
      .replace(/\{accountName\}/g, customerName)  // alias for {customerName}
      .replace(/\{category\}/g, category)
      .replace(/\{location\}/g, location)
      .replace(/\{digit\}/g, digitHint)
      .replace(/\{phone\}/g, phone);
  }
}
