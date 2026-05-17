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

@Controller('webhooks')
@UseGuards(WebhookRateLimitGuard)
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly webhooksService: WebhooksService,
    private readonly twilioWebhooksService: TwilioWebhooksService,
    private readonly callConnectService: CallConnectService,
    private readonly messagingService: MessagingService,
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
      const authToken = await this.twilioWebhooksService.getAuthToken(workspace.id);
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
      const authToken = await this.twilioWebhooksService.getAuthToken(workspace.id);
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
      twiml = await this.twilioWebhooksService.handleIncomingCall(workspace.id, payload);
    }

    // Return TwiML response
    res.status(200).set('Content-Type', 'text/xml').send(twiml);
  }

  /**
   * Handle recording completion callbacks from Twilio.
   */
  @Post('twilio/recording-status')
  @HttpCode(HttpStatus.OK)
  async handleTwilioRecordingStatus(@Body() payload: TwilioRecordingPayload) {
    this.logger.log(`Twilio recording status: ${payload.CallSid} -> ${payload.RecordingSid}`);
    await this.twilioWebhooksService.handleRecordingComplete(payload);
    return '';
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

  // ==================== TELEGRAM WEBHOOKS ====================

  /**
   * Receive normalized inbound message events from the Telegram connector
   * service drainer.
   *
   * Auth: x-webhook-key header must match SIGCORE_WEBHOOK_KEY.
   * Payload shape (set by telegram-connector/sigcore-ingest.service.ts):
   *   { eventType, provider: 'telegram', data: NormalizedInboundMessage, timestamp }
   */
  @Post('telegram/inbound')
  @HttpCode(HttpStatus.OK)
  async handleTelegramInbound(
    @Headers('x-webhook-key') webhookKey: string,
    @Body() payload: {
      eventType: string;
      provider: 'telegram';
      data: Record<string, unknown>;
      timestamp: string;
    },
  ) {
    const expectedKey = process.env.SIGCORE_WEBHOOK_KEY;
    if (expectedKey && webhookKey !== expectedKey) {
      this.logger.warn('Invalid Telegram webhook key');
      throw new BadRequestException('Invalid webhook key');
    }

    const tenantId = (payload?.data as any)?.tenantId;
    this.logger.log(
      `Telegram inbound: ${payload?.eventType} for tenant ${tenantId ?? 'unknown'}`,
    );

    await this.webhooksService.handleTelegramWebhook(
      payload.eventType,
      payload.data,
    );

    return { received: true };
  }

  /**
   * Receive Telegram provider lifecycle events
   * (provider.account.connected/disconnected, message.received/sent/failed,
   * conversation.updated) emitted by the connector.
   *
   * Separate channel from inbound message ingestion so downstream products
   * can subscribe to signals without parsing the message firehose.
   */
  @Post('telegram/provider-events')
  @HttpCode(HttpStatus.OK)
  async handleTelegramProviderEvent(
    @Headers('x-webhook-key') webhookKey: string,
    @Body() event: {
      type: string;
      provider: 'telegram';
      tenantId: string;
      accountId?: string;
      timestamp: string;
      data: Record<string, unknown>;
    },
  ) {
    const expectedKey = process.env.SIGCORE_WEBHOOK_KEY;
    if (expectedKey && webhookKey !== expectedKey) {
      this.logger.warn('Invalid Telegram provider-event key');
      throw new BadRequestException('Invalid webhook key');
    }

    this.logger.log(
      `Telegram provider event: ${event.type} tenant=${event.tenantId} account=${event.accountId ?? 'n/a'}`,
    );

    await this.webhooksService.handleTelegramProviderEvent(event);

    return { received: true };
  }
}
