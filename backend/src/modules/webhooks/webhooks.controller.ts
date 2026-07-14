import {
  Controller,
  Post,
  Body,
  Param,
  Query,
  Header,
  Headers,
  RawBodyRequest,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  BadRequestException,
  NotFoundException,
  Logger,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { WebhooksService, OpenPhoneWebhookPayload } from './webhooks.service';
import {
  TwilioWebhooksService,
  TwilioSmsWebhookPayload,
  TwilioSmsStatusPayload,
  TwilioVoiceWebhookPayload,
  TwilioCallStatusPayload,
  TwilioRecordingPayload,
} from './twilio-webhooks.service';
import { WebhookRateLimitGuard } from './webhook-rate-limit.guard';
import { CallConnectService } from './call-connect.service';
import { MessagingService } from '../messaging/messaging.service';
import { CallbackForwarderService } from './callback-forwarder.service';
import {
  verifyCallbackToken,
  CallbackTokenKind,
} from './sigcore-callback-token.util';

/**
 * Task 6B.5C rawBody-fallback helper.
 *
 * Sigcore's `main.ts` registers `bodyParser.urlencoded` via `app.use` AFTER
 * `NestFactory.create({ rawBody: true })`. Express body-parser reads the
 * request stream during its middleware pass, which leaves Nest's rawBody
 * capture with an empty buffer on form-encoded Twilio callback POSTs.
 *
 * The Task 6B.5C callback forwarder needs the exact bytes Twilio sent, so
 * when `req.rawBody` is empty we reconstruct the canonical
 * `application/x-www-form-urlencoded` body from the parsed payload — the
 * fields survived the parse even though the byte stream did not. Mirrors
 * the fallback the inbound-voice handler has always used.
 *
 * Exported for direct unit-testing without an Express request harness.
 */
export function deriveForwardBody(
  rawBody: Buffer | undefined,
  parsedPayload: Record<string, string>,
): Buffer {
  if (rawBody && rawBody.length > 0) return rawBody;
  return Buffer.from(
    new URLSearchParams(parsedPayload ?? {}).toString(),
    'utf8',
  );
}

@Controller('webhooks')
@UseGuards(WebhookRateLimitGuard)
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly webhooksService: WebhooksService,
    private readonly twilioWebhooksService: TwilioWebhooksService,
    private readonly callConnectService: CallConnectService,
    private readonly messagingService: MessagingService,
    /** Task 6B.5C — sign + forward callbacks to Callio with HMAC envelope. */
    private readonly callbackForwarder: CallbackForwarderService,
  ) {}

  @Post('openphone/:webhookId')
  @HttpCode(HttpStatus.OK)
  async handleOpenPhoneWebhook(
    @Param('webhookId') webhookId: string,
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-openphone-signature') signature: string,
    @Body() payload: OpenPhoneWebhookPayload,
  ) {
    // Find workspace by webhook ID
    const workspace = await this.webhooksService.getWorkspaceByWebhookId(webhookId);

    if (!workspace) {
      throw new NotFoundException('Invalid webhook URL');
    }

    const rawBody = req.rawBody?.toString() || JSON.stringify(payload);

    // Verify signature if provided
    if (signature) {
      const isValid = await this.webhooksService.verifyOpenPhoneSignature(
        workspace.id,
        rawBody,
        signature,
      );

      if (!isValid) {
        throw new BadRequestException('Invalid webhook signature');
      }
    }

    await this.webhooksService.handleOpenPhoneWebhook(workspace.id, payload);

    return { received: true };
  }

  // ==================== TWILIO WEBHOOKS ====================

  // ==================== LeadBridge SMS WEBHOOKS ====================

  /**
   * Incoming SMS for LeadBridge bot numbers — tenant-scoped variant.
   * Each LeadBridge SavedAccount registers its Twilio webhook against its own
   * tenantId so Sigcore can deliver only to that tenant's subscription
   * (Issue #114 — prevents cross-tenant fan-out).
   *
   * POST /webhooks/twilio/sms/lb/:tenantId
   *
   * IMPORTANT: 3-segment path so it does not collide with the BYO route
   * twilio/sms/:webhookId (2 segments).
   */
  @Post('twilio/sms/lb/:tenantId')
  @HttpCode(HttpStatus.OK)
  async handleTwilioSmsInboundForTenant(
    @Param('tenantId') tenantId: string,
    @Body('From') from: string,
    @Body('To') to: string,
    @Body('Body') body: string,
    @Body('MessageSid') messageSid: string,
  ) {
    this.logger.log(`Inbound SMS from ${from} to ${to} (${messageSid}) tenant=${tenantId}`);
    await this.messagingService.handleIncomingSms(to, from, body, messageSid, tenantId);
    return '';
  }

  /**
   * Legacy LeadBridge bot inbound SMS — no tenant context in the URL.
   * Kept for backward compatibility with already-registered Twilio webhooks.
   * Treated as UNSAFE: emitEvent will restrict delivery to unscoped
   * subscriptions only, never tenant-scoped ones (Issue #114).
   * New SavedAccount registrations should use /twilio/sms/lb/:tenantId.
   *
   * POST /webhooks/twilio/sms
   */
  @Post('twilio/sms')
  @HttpCode(HttpStatus.OK)
  async handleTwilioSmsInbound(
    @Body('From') from: string,
    @Body('To') to: string,
    @Body('Body') body: string,
    @Body('MessageSid') messageSid: string,
  ) {
    this.logger.warn(
      `[legacy route] Inbound SMS from ${from} to ${to} (${messageSid}) — no tenantId, ` +
        `delivery restricted to unscoped subs`,
    );
    await this.messagingService.handleIncomingSms(to, from, body, messageSid);
    return '';
  }

  /**
   * Delivery status callbacks for LeadBridge outbound SMS.
   * Updates sms_messages status and emits webhook events.
   *
   * POST /webhooks/twilio/sms-status
   */
  @Post('twilio/sms-status')
  @HttpCode(HttpStatus.OK)
  async handleTwilioSmsStatusLeadBridge(
    @Body('MessageSid') messageSid: string,
    @Body('MessageStatus') messageStatus: string,
    @Body('ErrorCode') errorCode: string,
  ) {
    this.logger.log(`SMS status: ${messageSid} → ${messageStatus}`);
    await this.messagingService.handleSmsStatus(messageSid, messageStatus, errorCode || undefined);
    return '';
  }

  /**
   * Handle SMS status callbacks from Twilio.
   * IMPORTANT: This route must be defined BEFORE twilio/sms/:webhookId to avoid route conflicts
   */
  @Post('twilio/sms/status')
  @HttpCode(HttpStatus.OK)
  async handleTwilioSmsStatus(@Body() payload: TwilioSmsStatusPayload) {
    this.logger.log(`Twilio SMS status webhook: ${payload.MessageSid} -> ${payload.MessageStatus}`);
    await this.twilioWebhooksService.handleSmsStatus(payload);
    return '';
  }

  /**
   * Handle incoming SMS from Twilio.
   * Twilio sends form-encoded data, not JSON.
   */
  @Post('twilio/sms/:webhookId')
  @HttpCode(HttpStatus.OK)
  async handleTwilioSms(
    @Param('webhookId') webhookId: string,
    @Req() req: Request,
    @Headers('x-twilio-signature') signature: string,
    @Body() payload: TwilioSmsWebhookPayload,
  ) {
    this.logger.log(`Twilio SMS webhook received for ${webhookId}`);

    const workspace = await this.twilioWebhooksService.getWorkspaceByWebhookId(webhookId);

    if (!workspace) {
      throw new NotFoundException('Invalid webhook URL');
    }

    // Verify Twilio signature
    if (signature) {
      // Phase 4a — pass AccountSid so we deterministically pick the correct
      // integration row when a workspace holds multiple Twilio integrations
      // (workspace-scoped + tenant-scoped rows).
      const authToken = await this.twilioWebhooksService.getAuthToken(
        workspace.id,
        payload?.AccountSid,
      );
      if (authToken) {
        const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
        const isValid = this.twilioWebhooksService.verifyTwilioSignature(
          authToken,
          signature,
          fullUrl,
          payload as unknown as Record<string, string>,
        );

        if (!isValid) {
          this.logger.warn('Invalid Twilio signature');
          throw new BadRequestException('Invalid webhook signature');
        }
      }
    }

    await this.twilioWebhooksService.handleIncomingSms(workspace.id, payload);

    return ''; // Twilio expects empty response for SMS
  }

  /**
   * Handle call status callbacks from Twilio.
   * IMPORTANT: This route must be defined BEFORE twilio/voice/:webhookId to avoid route conflicts
   */
  @Post('twilio/voice/status')
  @HttpCode(HttpStatus.OK)
  async handleTwilioCallStatus(@Body() payload: TwilioCallStatusPayload) {
    this.logger.log(`Twilio call status webhook: ${payload.CallSid} -> ${payload.CallStatus}`);
    await this.twilioWebhooksService.handleCallStatus(payload);
    return '';
  }

  /**
   * Phase B.1 — workspace-scoped call-status callback receiver.
   *
   * Same shape as `POST /twilio/voice/:webhookId` but for status callbacks.
   * The webhookId in the path lets us verify the X-Twilio-Signature against
   * that workspace's Twilio integration credentials (which we can't do on
   * the legacy `/twilio/voice/status` route because it carries no
   * workspace binding). After signature verification we forward the
   * callback to the tenant's Callio status endpoint under a Sigcore HMAC
   * envelope (voice_call_status), so Callio sees the same
   * `voice_calls.status/startedAt/endedAt/durationSeconds` updates it
   * used to get from the (pre-Phase-B) direct Twilio→Callio status_callback.
   *
   * Deploy step: set the pilot number's Twilio `StatusCallback` URL to
   * `${SIGCORE_BASE_URL}/api/webhooks/twilio/voice/status/${webhookId}`.
   * The legacy `/twilio/voice/status` route stays live for Call Connect's
   * internal status callbacks; the new scoped route is what number-level
   * status_callback configs point at.
   *
   * IMPORTANT: this route must be defined BEFORE `twilio/voice/:webhookId`
   * to avoid the wildcard swallowing it.
   */
  @Post('twilio/voice/status/:webhookId')
  @HttpCode(HttpStatus.OK)
  async handleTwilioCallStatusScoped(
    @Param('webhookId') webhookId: string,
    @Req() req: Request,
    @Headers('x-twilio-signature') signature: string,
    @Body() payload: TwilioCallStatusPayload,
  ) {
    this.logger.log(
      `Twilio call status (scoped): ${payload.CallSid} -> ${payload.CallStatus} webhookId=${webhookId.slice(0, 8)}`,
    );

    const workspace = await this.twilioWebhooksService.getWorkspaceByWebhookId(webhookId);
    if (!workspace) throw new NotFoundException('Invalid webhook URL');

    // Verify Twilio signature. Twilio always includes X-Twilio-Signature on
    // status callbacks; a missing signature is treated as a protocol error.
    if (!signature) {
      throw new BadRequestException('Missing X-Twilio-Signature header');
    }
    // Phase 4a — pass AccountSid so the correct integration row is chosen
    // when a workspace holds multiple Twilio integrations.
    const authToken = await this.twilioWebhooksService.getAuthToken(
      workspace.id,
      payload?.AccountSid,
    );
    if (authToken) {
      const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
      const isValid = this.twilioWebhooksService.verifyTwilioSignature(
        authToken,
        signature,
        fullUrl,
        payload as unknown as Record<string, string>,
      );
      if (!isValid) {
        this.logger.warn(
          `Invalid Twilio status signature webhookId=${webhookId.slice(0, 8)} callSid=${payload.CallSid}`,
        );
        throw new BadRequestException('Invalid webhook signature');
      }
    } else {
      // No stored auth token means we can't verify — fail closed to prevent
      // a mis-provisioned workspace from accepting unsigned status POSTs.
      this.logger.warn(
        `No auth token for workspace=${workspace.id} — refusing unsigned scoped status callback`,
      );
      throw new BadRequestException('Workspace not provisioned for signature verification');
    }

    // Update Sigcore's own state (same as the legacy route).
    await this.twilioWebhooksService.handleCallStatus(payload);

    // Forward to Callio if the tenant is configured for it.
    const forwardResult = await this.twilioWebhooksService.forwardCallStatusToCallio(
      workspace.id,
      payload,
      req as RawBodyRequest<Request>,
      signature,
    );
    this.logger.log(
      `sigcore_call_status_forward outcome=${forwardResult.outcome} reason=${forwardResult.reason ?? 'ok'} callSid=${payload.CallSid}`,
    );
    return '';
  }

  /**
   * Handle forwarded inbound call dial status (Dial action callback).
   * Called when an inbound call forwarded to an agent's phone completes.
   * MUST be before twilio/voice/:webhookId to avoid route conflicts.
   */
  @Post('twilio/voice/forward-status')
  @HttpCode(HttpStatus.OK)
  @Header('Content-Type', 'text/xml')
  async handleForwardDialStatus(@Body() payload: any) {
    this.logger.log(
      `Twilio forward dial status: CallSid=${payload.CallSid} DialCallStatus=${payload.DialCallStatus}`,
    );
    // Resolve workspace from the Twilio number (To = the dedicated number that was called)
    const toNumber = payload.To;
    const workspaceId = toNumber
      ? await this.twilioWebhooksService.getWorkspaceIdByPhoneNumber(toNumber)
      : null;
    if (workspaceId) {
      return await this.twilioWebhooksService.handleForwardDialStatus(
        workspaceId,
        payload,
      );
    }
    // Fallback: return voicemail
    return this.twilioWebhooksService.generateVoicemailTwiML();
  }

  // ==================== CALL CONNECT TwiML WEBHOOKS ====================
  // These must be defined BEFORE twilio/voice/:webhookId to avoid route conflicts.

  /**
   * Wave-2 Phase C — outbound-dial answer TwiML.
   *
   * Public, stateless endpoint that Twilio hits when an outbound call
   * placed via `POST /api/v1/calls/dial` is answered. The route derives
   * its TwiML entirely from query params so there's no per-call server
   * state to maintain.
   *
   * Modes:
   *   ?mode=hangup            → <Response><Hangup/></Response>
   *                             (used for connectivity canaries)
   *   ?mode=twiml_url&url=X   → <Response><Redirect method="POST">X</Redirect></Response>
   *                             (delegates to caller-hosted TwiML — X should
   *                              be a URL the CALLING integration owns; this
   *                              route does NOT verify caller ownership of X,
   *                              so treat the URL query param as untrusted
   *                              and don't grant it privileges based on the
   *                              redirect landing there)
   *
   * Auth: none — Twilio itself is the caller. Content is fully determined
   * by URL params, so this endpoint has no capability to leak Sigcore
   * state.
   *
   * Route defined BEFORE `twilio/voice/:webhookId` to avoid wildcard match.
   */
  @Post('twilio/voice/outbound-answer')
  @HttpCode(HttpStatus.OK)
  async handleOutboundAnswerTwiml(
    @Query('mode') mode: string | undefined,
    @Query('url') url: string | undefined,
    @Res() res: Response,
  ) {
    const safeMode = mode === 'twiml_url' ? 'twiml_url' : 'hangup';
    let twiml: string;
    if (safeMode === 'twiml_url' && url && /^https?:\/\//i.test(url)) {
      // Redirect Twilio to the caller-provided URL. Escape XML metacharacters
      // in the URL to defeat injection; the URL scheme check above rejects
      // non-http(s) values before we quote-escape.
      const escaped = url
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
      twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Redirect method="POST">${escaped}</Redirect></Response>`;
    } else {
      twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`;
    }
    res.status(200).set('Content-Type', 'text/xml').send(twiml);
  }

  /**
   * Phase C.2 — token-scoped outbound-answer for media_stream mode.
   *
   * When `POST /v1/calls/dial` is called with `answerMode=media_stream`,
   * Sigcore mints a signed single-use `media_session` token and hands
   * Twilio an answer URL that embeds that token. Twilio then POSTs to
   * this route when the destination picks up.
   *
   * We verify the token here (kind='media_session', not expired, HMAC valid),
   * inject the token as a `?session=` query param on Callio's WSS URL,
   * and return `<Connect><Stream/></Connect>` TwiML. Callio's
   * MediaStreamService then verifies the same token when the WSS opens.
   *
   * The token is single-use ONLY at the Callio hop (Redis SETNX on the
   * WSS side). This route does not enforce single-use because Twilio may
   * legitimately re-request the answer TwiML — e.g. if the initial TCP
   * request times out and Twilio retries. Single-use at the WSS hop
   * prevents replay attacks against the media stream itself.
   */
  @Post('twilio/voice/outbound-answer/:token')
  @HttpCode(HttpStatus.OK)
  async handleOutboundAnswerTokenTwiml(
    @Param('token') token: string,
    @Res() res: Response,
  ) {
    const secret = process.env.SIGCORE_VOICE_FORWARD_HMAC_SECRET;
    const verified = verifyCallbackToken({
      secret,
      token,
      expectedKind: 'media_session' as CallbackTokenKind,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    if (!verified.ok) {
      this.logger.warn(
        `outbound_answer_token_denied reason=${verified.reason} token_prefix=${token.slice(0, 8)}`,
      );
      // Twilio expects TwiML in the 200 response. Returning a Hangup here
      // fails-closed for the customer (call disconnects) without leaking
      // rejection details in the XML body. The warning log is our audit
      // trail.
      const hangupTwiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`;
      res.status(200).set('Content-Type', 'text/xml').send(hangupTwiml);
      return;
    }
    const wssBase = verified.payload.callioDestUrl;
    // Twilio Media Streams drops the WSS query string on ~50% of upgrades
    // (documented behavior, same issue that motivates <Parameter> fallback
    // on the inbound path). We MUST convey the session token via
    // <Parameter> inside <Stream> so Callio's MediaStreamService picks it
    // up from the start-event's customParameters. Also include it in the
    // URL query as a belt-and-suspenders fallback for cases where Twilio
    // does preserve the query — Callio prefers the query when both present.
    const separator = wssBase.includes('?') ? '&' : '?';
    const wssUrl = `${wssBase}${separator}session=${encodeURIComponent(token)}`;
    const xmlEscape = (s: string): string =>
      s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
    const twiml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Response><Connect>` +
      `<Stream url="${xmlEscape(wssUrl)}">` +
      `<Parameter name="session" value="${xmlEscape(token)}"/>` +
      `</Stream>` +
      `</Connect></Response>`;
    res.status(200).set('Content-Type', 'text/xml').send(twiml);
  }

  /**
   * TwiML endpoint for the agent leg of a Call Connect session.
   * Twilio calls this when the agent's phone rings.
   * Returns a whisper + Gather (AGENT_FIRST) or direct conference join (PARALLEL).
   *
   * POST /webhooks/twilio/voice/agent?sessionId=<uuid>
   */
  @Post('twilio/voice/agent')
  async handleCallConnectAgentTwiml(
    @Query('sessionId') sessionId: string,
    @Res() res: Response,
  ) {
    this.logger.log(`Call Connect agent TwiML: sessionId=${sessionId}`);
    const twiml = await this.callConnectService.handleAgentTwiml(sessionId);
    res.status(200).set('Content-Type', 'text/xml').send(twiml);
  }

  /**
   * TwiML endpoint for the lead leg of a Call Connect session.
   * Twilio calls this when the lead answers.
   * Returns TwiML to join the conference.
   *
   * POST /webhooks/twilio/voice/lead?sessionId=<uuid>
   */
  @Post('twilio/voice/lead')
  async handleCallConnectLeadTwiml(
    @Query('sessionId') sessionId: string,
    @Body('AnsweredBy') answeredBy: string,
    @Res() res: Response,
  ) {
    this.logger.log(`Call Connect lead TwiML: sessionId=${sessionId}, answeredBy=${answeredBy || 'none'}`);
    const twiml = await this.callConnectService.handleLeadTwiml(sessionId, answeredBy);
    res.status(200).set('Content-Type', 'text/xml').send(twiml);
  }

  /**
   * Conference waitUrl TwiML for the lead.
   * Plays the configured greeting in a loop while the lead waits for the agent to join.
   * Running inside the conference hold state means no TTS startup delay on pick-up.
   *
   * POST /webhooks/twilio/voice/lead/wait?sessionId=<uuid>
   */
  @Post('twilio/voice/lead/wait')
  async handleCallConnectLeadWait(
    @Query('sessionId') sessionId: string,
    @Res() res: Response,
  ) {
    this.logger.log(`Call Connect lead wait TwiML: sessionId=${sessionId}`);
    const twiml = await this.callConnectService.handleLeadWaitTwiml(sessionId);
    res.status(200).set('Content-Type', 'text/xml').send(twiml);
  }

  /**
   * Async AMD callback for the lead leg.
   * Called when Twilio determines if the lead answered or voicemail picked up.
   *
   * POST /webhooks/twilio/voice/lead/amd?sessionId=<uuid>
   */
  @Post('twilio/voice/lead/amd')
  @HttpCode(HttpStatus.NO_CONTENT)
  async handleCallConnectLeadAmd(
    @Query('sessionId') sessionId: string,
    @Body('CallSid') callSid: string,
    @Body('AnsweredBy') answeredBy: string,
  ) {
    this.logger.log(`Lead AMD: sessionId=${sessionId}, callSid=${callSid}, answeredBy=${answeredBy}`);
    if (sessionId && callSid) {
      await this.callConnectService.handleLeadAmd(sessionId, callSid, answeredBy);
    }
  }

  /**
   * Voicemail drop TwiML — played to the lead's voicemail when AMD detects a machine.
   *
   * POST /webhooks/twilio/voice/lead/voicemail?sessionId=<uuid>
   */
  @Post('twilio/voice/lead/voicemail')
  async handleCallConnectLeadVoicemail(
    @Query('sessionId') sessionId: string,
    @Query('answeredBy') answeredBy: string,
    @Res() res: Response,
  ) {
    this.logger.log(`Lead voicemail drop TwiML: sessionId=${sessionId}, answeredBy=${answeredBy || 'unknown'}`);
    const twiml = await this.callConnectService.handleLeadVoicemailTwiml(sessionId, answeredBy);
    res.status(200).set('Content-Type', 'text/xml').send(twiml);
  }

  /**
   * Agent voicemail hold TwiML — SPEAK voicemail mode only.
   * Plays a notification then parks the agent in a private conference waiting
   * for the lead's voicemail leg to join (which starts the conference and bridges them).
   *
   * POST /webhooks/twilio/voice/agent/voicemail-hold?sessionId=<uuid>
   */
  @Post('twilio/voice/agent/voicemail-hold')
  async handleCallConnectAgentVoicemailHold(
    @Query('sessionId') sessionId: string,
    @Res() res: Response,
  ) {
    this.logger.log(`Call Connect agent voicemail hold TwiML: sessionId=${sessionId}`);
    const twiml = await this.callConnectService.handleAgentVoicemailHoldTwiml(sessionId);
    res.status(200).set('Content-Type', 'text/xml').send(twiml);
  }

  /**
   * Lead voicemail bridge TwiML — SPEAK voicemail mode only.
   * Called by Twilio after DetectMessageEnd fires (beep detected).
   * Joins the same private conference as the agent, bridging them so the agent
   * can speak directly into the lead's voicemail.
   *
   * POST /webhooks/twilio/voice/lead/voicemail-agent?sessionId=<uuid>
   */
  @Post('twilio/voice/lead/voicemail-agent')
  async handleCallConnectLeadVoicemailAgent(
    @Query('sessionId') sessionId: string,
    @Res() res: Response,
  ) {
    this.logger.log(`Call Connect lead voicemail-agent TwiML: sessionId=${sessionId}`);
    const twiml = await this.callConnectService.handleLeadVoicemailAgentTwiml(sessionId);
    res.status(200).set('Content-Type', 'text/xml').send(twiml);
  }

  /**
   * Fired when the lead's conference <Dial> completes (conference ended).
   * Routes the lead to voicemail-hold if a voicemail choice is in progress,
   * or hangs up if the session is already terminal.
   *
   * POST /webhooks/twilio/voice/lead/after-conference?sessionId=<uuid>
   */
  @Post('twilio/voice/lead/after-conference')
  @HttpCode(HttpStatus.OK)
  async handleCallConnectLeadAfterConference(
    @Query('sessionId') sessionId: string,
    @Res() res: Response,
  ) {
    this.logger.log(`Lead after-conference: sessionId=${sessionId}`);
    const twiml = await this.callConnectService.handleLeadAfterConferenceTwiml(sessionId);
    res.status(200).set('Content-Type', 'text/xml').send(twiml);
  }

  /**
   * Silent hold loop for the lead during voicemail-choice.
   * Keeps the lead call alive while the agent decides which mode to use.
   *
   * POST /webhooks/twilio/voice/lead/voicemail-hold?sessionId=<uuid>
   */
  @Post('twilio/voice/lead/voicemail-hold')
  @HttpCode(HttpStatus.OK)
  async handleCallConnectLeadVoicemailHold(
    @Query('sessionId') sessionId: string,
    @Res() res: Response,
  ) {
    this.logger.log(`Lead voicemail hold: sessionId=${sessionId}`);
    const twiml = await this.callConnectService.handleLeadVoicemailHoldTwiml(sessionId);
    res.status(200).set('Content-Type', 'text/xml').send(twiml);
  }

  /**
   * Voicemail-choice prompt for the agent.
   * Press 1 → personal message (SPEAK). Any other key → automated drop.
   *
   * POST /webhooks/twilio/voice/agent/voicemail-choice?sessionId=<uuid>&answeredBy=<value>
   */
  @Post('twilio/voice/agent/voicemail-choice')
  @HttpCode(HttpStatus.OK)
  async handleCallConnectAgentVoicemailChoice(
    @Query('sessionId') sessionId: string,
    @Query('answeredBy') answeredBy: string,
    @Res() res: Response,
  ) {
    this.logger.log(`Agent voicemail choice: sessionId=${sessionId}, answeredBy=${answeredBy}`);
    const twiml = await this.callConnectService.handleAgentVoicemailChoiceTwiml(sessionId, answeredBy);
    res.status(200).set('Content-Type', 'text/xml').send(twiml);
  }

  /**
   * Gather action for the agent's voicemail choice.
   * Digit "1" → SPEAK (personal). Anything else or timeout (Digits="") → automated.
   *
   * POST /webhooks/twilio/voice/agent/voicemail-choice-action?sessionId=<uuid>&answeredBy=<value>
   */
  @Post('twilio/voice/agent/voicemail-choice-action')
  @HttpCode(HttpStatus.OK)
  async handleCallConnectAgentVoicemailChoiceAction(
    @Query('sessionId') sessionId: string,
    @Query('answeredBy') answeredBy: string,
    @Body('Digits') digits: string,
    @Res() res: Response,
  ) {
    this.logger.log(`Agent voicemail choice action: sessionId=${sessionId}, digits=${digits}, answeredBy=${answeredBy}`);
    const twiml = await this.callConnectService.handleAgentVoicemailChoiceAction(sessionId, digits || '', answeredBy);
    res.status(200).set('Content-Type', 'text/xml').send(twiml);
  }

  /**
   * Gather action callback — called when the agent presses a digit.
   * Advances the session state machine and returns conference TwiML (accepted)
   * or hangup TwiML (declined).
   *
   * POST /webhooks/twilio/voice/agent/gather?sessionId=<uuid>
   * Body: Digits=<digit> (Twilio form-encoded)
   */
  @Post('twilio/voice/agent/gather')
  async handleCallConnectAgentGather(
    @Query('sessionId') sessionId: string,
    @Body('Digits') digits: string,
    @Res() res: Response,
  ) {
    this.logger.log(`Call Connect gather: sessionId=${sessionId}, digits=${digits}`);
    const twiml = await this.callConnectService.handleAgentGatherAction(sessionId, digits || '');
    res.status(200).set('Content-Type', 'text/xml').send(twiml);
  }

  /**
   * Async Answering Machine Detection callback from Twilio.
   * Called when AMD determines if an agent call was answered by a human or voicemail.
   *
   * POST /webhooks/twilio/voice/amd?sessionId=<uuid>
   * Body: CallSid=<sid>&AnsweredBy=<human|machine_start|machine_end_beep|...>
   */
  @Post('twilio/voice/amd')
  @HttpCode(HttpStatus.NO_CONTENT)
  async handleCallConnectAmd(
    @Query('sessionId') sessionId: string,
    @Body('CallSid') callSid: string,
    @Body('AnsweredBy') answeredBy: string,
  ) {
    this.logger.log(`Call Connect AMD: sessionId=${sessionId}, callSid=${callSid}, answeredBy=${answeredBy}`);
    if (sessionId && callSid) {
      await this.callConnectService.handleAgentAmd(sessionId, callSid, answeredBy);
    }
  }

  /**
   * Handle incoming voice calls from Twilio.
   * Must return TwiML XML response.
   */
  @Post('twilio/voice/:webhookId')
  async handleTwilioVoice(
    @Param('webhookId') webhookId: string,
    @Req() req: Request,
    @Res() res: Response,
    @Headers('x-twilio-signature') signature: string,
    @Body() payload: TwilioVoiceWebhookPayload,
  ) {
    this.logger.log(`Twilio voice webhook received for ${webhookId}`);

    const workspace = await this.twilioWebhooksService.getWorkspaceByWebhookId(webhookId);

    if (!workspace) {
      throw new NotFoundException('Invalid webhook URL');
    }

    // Verify Twilio signature
    if (signature) {
      // Phase 4a — pass AccountSid so the correct integration row is chosen
      // when a workspace holds multiple Twilio integrations.
      const authToken = await this.twilioWebhooksService.getAuthToken(
        workspace.id,
        payload?.AccountSid,
      );
      if (authToken) {
        const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
        const isValid = this.twilioWebhooksService.verifyTwilioSignature(
          authToken,
          signature,
          fullUrl,
          payload as unknown as Record<string, string>,
        );

        if (!isValid) {
          this.logger.warn('Invalid Twilio voice signature');
          throw new BadRequestException('Invalid webhook signature');
        }
      }
    }

    let twiml: string;

    if (payload.Direction !== 'inbound') {
      twiml = await this.twilioWebhooksService.handleOutgoingCall(workspace.id, payload);
    } else {
      // Wave-2 Voice Foundation PR 3 — pass the forward context so the tenant
      // voice-forward step (guarded by SIGCORE_VOICE_INBOUND_FORWARD_ENABLED)
      // can proxy Twilio's request verbatim to the tenant. Uses `req.rawBody`
      // (main.ts already enables `rawBody: true` on NestFactory) so what
      // Twilio POSTed is what the tenant receives — no re-encoding, no field
      // reordering. Falls back to a URLSearchParams re-encoding of the
      // parsed payload if rawBody isn't populated for some reason (defensive
      // — should not happen in production).
      const rawReq = req as unknown as {
        rawBody?: Buffer;
        headers: Record<string, string | string[] | undefined>;
      };
      const rawBody: Buffer | string =
        rawReq.rawBody ?? new URLSearchParams(payload as unknown as Record<string, string>).toString();
      const contentType =
        typeof rawReq.headers['content-type'] === 'string'
          ? (rawReq.headers['content-type'] as string)
          : 'application/x-www-form-urlencoded';
      const forwardedHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(rawReq.headers)) {
        if (k.toLowerCase().startsWith('x-forwarded-') && typeof v === 'string') {
          forwardedHeaders[k] = v;
        }
      }
      twiml = await this.twilioWebhooksService.handleIncomingCall(
        workspace.id,
        payload,
        {
          rawBody,
          contentType,
          twilioSignature: signature,
          forwardedHeaders,
        },
      );
    }

    // Return TwiML response
    res.status(200).set('Content-Type', 'text/xml').send(twiml);
  }

  /**
   * Handle recording completion callbacks from Twilio.
   *
   * Legacy route (used by direct-Twilio integrations with credentials on
   * Sigcore's own account). Task 6B.5C keeps this endpoint working so
   * existing setups don't regress.
   */
  @Post('twilio/recording-status')
  @HttpCode(HttpStatus.OK)
  async handleTwilioRecordingStatus(@Body() payload: TwilioRecordingPayload) {
    this.logger.log(`Twilio recording status: ${payload.CallSid} -> ${payload.RecordingSid}`);
    await this.twilioWebhooksService.handleRecordingComplete(payload);
    return '';
  }

  /**
   * Task 6B.5C — Twilio → Sigcore → Callio recording-status callback.
   *
   * Sigcore mints the token when Callio calls
   * `POST /v1/calls/:sid/recording/start`; Twilio POSTs here when the
   * recording completes. Sigcore verifies the token (proves Sigcore
   * minted this URL), then verifies Twilio's X-Twilio-Signature against
   * the subaccount that placed the call, then HMAC-signs the outbound
   * envelope and forwards to the Callio URL embedded in the token.
   *
   * The Twilio signature check + subaccount attribution is the whole
   * reason this callback goes through Sigcore instead of directly to
   * Callio — Callio's Twilio auth token would not match a subaccount
   * signature. See docs/OPERATIONAL_READINESS.md.
   */
  @Post('twilio/recording-status/:token')
  @HttpCode(HttpStatus.OK)
  async handleTwilioRecordingStatusForwarded(
    @Param('token') token: string,
    @Body() payload: TwilioRecordingPayload,
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-twilio-signature') twilioSignature: string,
  ) {
    return this.handleTwilioCallbackForwarded(
      'recording_status',
      token,
      req,
      payload as unknown as Record<string, string>,
      twilioSignature,
    );
  }

  /**
   * Task 6B.5C — Twilio → Sigcore → Callio call-status callback (mirror
   * of recording-status). The token is minted when Sigcore purchases a
   * voice number for a Callio-owned tenant; Twilio's `statusCallback`
   * for that number points here.
   */
  @Post('twilio/status/:token')
  @HttpCode(HttpStatus.OK)
  async handleTwilioCallStatusForwarded(
    @Param('token') token: string,
    @Body() payload: TwilioCallStatusPayload,
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-twilio-signature') twilioSignature: string,
  ) {
    return this.handleTwilioCallbackForwarded(
      'call_status',
      token,
      req,
      payload as unknown as Record<string, string>,
      twilioSignature,
    );
  }

  /**
   * Shared handler for Task 6B.5C token-carrying callback routes. Verifies
   * the URL token, verifies Twilio's signature via the subaccount that
   * owns the call, then forwards to Callio under an HMAC envelope.
   *
   * On any verification failure returns 200 empty (Twilio doesn't need to
   * know why, but retries would loop) plus a structured warn line so ops
   * can spot forged / stale / mis-routed callbacks in Loki.
   */
  private async handleTwilioCallbackForwarded(
    kind: CallbackTokenKind,
    token: string,
    req: RawBodyRequest<Request>,
    payload: Record<string, string>,
    twilioSignature: string,
  ): Promise<string> {
    const secret = process.env.SIGCORE_VOICE_FORWARD_HMAC_SECRET;
    const verify = verifyCallbackToken({
      secret,
      token,
      expectedKind: kind,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    if (!verify.ok) {
      this.logger.warn(
        `sigcore_callback_token_denied kind=${kind} reason=${verify.reason} callSid=${payload.CallSid ?? 'null'}`,
      );
      // Return 200 empty so Twilio does not retry a permanently-bad URL.
      return '';
    }
    const providerCallSid = payload.CallSid ?? '';
    if (!providerCallSid) {
      this.logger.warn(`sigcore_callback_missing_call_sid kind=${kind}`);
      return '';
    }

    // Verify Twilio's signature via the subaccount that owns the call.
    // This is the check Callio itself cannot perform because Sigcore holds
    // the subaccount tokens. Reuses TwilioWebhooksService's existing
    // signature-verification helper, keyed on the payload's AccountSid.
    // On mismatch we still forward NOTHING — Callio never learns about
    // the callback and Sigcore emits a security warning.
    try {
      const twilioOk = await this.twilioWebhooksService.verifyRecordingCallbackSignature(
        payload as unknown as { AccountSid?: string; [k: string]: string | undefined },
        twilioSignature,
        this.reconstructUrl(req),
      );
      if (!twilioOk) {
        this.logger.warn(
          `sigcore_callback_twilio_sig_denied kind=${kind} callSid=${providerCallSid} sigcoreWorkspaceId=${this.maskId(verify.payload.sigcoreWorkspaceId)}`,
        );
        return '';
      }
    } catch (err) {
      this.logger.warn(
        `sigcore_callback_twilio_verify_error kind=${kind} err=${(err as Error).message.slice(0, 200)}`,
      );
      // Do NOT proceed. We prefer dropping over false forwarding.
      return '';
    }

    // Forward to Callio with a Sigcore HMAC envelope. Mirror the inbound
    // handler's fallback: express bodyParser may have consumed the raw
    // stream before Nest's rawBody capture ran, so `req.rawBody` can be
    // empty even for a form-encoded Twilio POST. In that case reconstruct
    // the canonical form-urlencoded body from the parsed payload — Callio
    // sees the same fields Twilio sent, in the same encoding.
    const rawBody: Buffer = deriveForwardBody(req.rawBody, payload);
    const contentType = req.headers['content-type'] || 'application/x-www-form-urlencoded';
    const forwardEventType = this.callbackForwarder.eventTypeForKind(kind);
    if (
      forwardEventType !== 'voice_recording_status' &&
      forwardEventType !== 'voice_call_status'
    ) {
      // Unreachable — the kind→eventType mapping only ever produces the
      // two callback event types; narrowing here keeps the compiler happy.
      return '';
    }
    const result = await this.callbackForwarder.forward({
      eventType: forwardEventType,
      callioDestUrl: verify.payload.callioDestUrl,
      sigcoreWorkspaceId: verify.payload.sigcoreWorkspaceId,
      sigcoreTenantId: verify.payload.sigcoreTenantId,
      providerCallSid,
      rawBody: Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody)),
      contentType: typeof contentType === 'string' ? contentType : 'application/x-www-form-urlencoded',
      twilioSignature,
    });
    if (result.outcome === 'fallback') {
      // Fallback: also persist to Sigcore's own tables so the recording
      // metadata isn't lost. Sigcore's existing legacy handler covers the
      // recording case; call-status has an existing local handler too.
      if (kind === 'recording_status') {
        await this.twilioWebhooksService.handleRecordingComplete(
          payload as unknown as TwilioRecordingPayload,
        ).catch((err) => {
          this.logger.warn(`sigcore_callback_local_persist_failed kind=${kind} err=${(err as Error).message.slice(0, 200)}`);
        });
      }
    }
    return '';
  }

  private reconstructUrl(req: Request): string {
    const proto = (req.headers['x-forwarded-proto'] as string) ?? req.protocol ?? 'https';
    const host = (req.headers['x-forwarded-host'] as string) ?? req.headers.host ?? '';
    return `${proto}://${host}${req.originalUrl}`;
  }

  private maskId(id: string | undefined): string {
    if (!id) return 'null';
    if (id.length <= 8) return '***';
    return `${id.slice(0, 4)}***${id.slice(-4)}`;
  }

  // ==================== WHATSAPP WEBHOOKS ====================

  /**
   * Receive inbound events from the WhatsApp microservice.
   * Auth: x-webhook-key header must match SIGCORE_WEBHOOK_KEY env var.
   */
  @Post('whatsapp/inbound')
  @HttpCode(HttpStatus.OK)
  async handleWhatsAppInbound(
    @Headers('x-webhook-key') webhookKey: string,
    @Body() payload: {
      workspaceId: string;
      eventType: string;
      data: Record<string, unknown>;
      timestamp: string;
    },
  ) {
    // Validate webhook key
    const expectedKey = process.env.SIGCORE_WEBHOOK_KEY;
    if (expectedKey && webhookKey !== expectedKey) {
      this.logger.warn('Invalid WhatsApp webhook key');
      throw new BadRequestException('Invalid webhook key');
    }

    this.logger.log(`WhatsApp webhook: ${payload.eventType} for workspace ${payload.workspaceId}`);

    await this.webhooksService.handleWhatsAppWebhook(
      payload.workspaceId,
      payload.eventType,
      payload.data,
    );

    return { received: true };
  }
}
