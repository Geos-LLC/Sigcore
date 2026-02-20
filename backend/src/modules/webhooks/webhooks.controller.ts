import {
  Controller,
  Post,
  Body,
  Param,
  Query,
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

@Controller('webhooks')
@UseGuards(WebhookRateLimitGuard)
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly webhooksService: WebhooksService,
    private readonly twilioWebhooksService: TwilioWebhooksService,
    private readonly callConnectService: CallConnectService,
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
    res.set('Content-Type', 'text/xml');
    res.send(twiml);
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
    @Res() res: Response,
  ) {
    this.logger.log(`Call Connect lead TwiML: sessionId=${sessionId}`);
    const twiml = await this.callConnectService.handleLeadTwiml(sessionId);
    res.set('Content-Type', 'text/xml');
    res.send(twiml);
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
    @Res() res: Response,
  ) {
    this.logger.log(`Lead voicemail drop TwiML: sessionId=${sessionId}`);
    const twiml = await this.callConnectService.handleLeadVoicemailTwiml(sessionId);
    res.set('Content-Type', 'text/xml');
    res.send(twiml);
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
    res.set('Content-Type', 'text/xml');
    res.send(twiml);
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
    this.logger.log(`========== TWILIO VOICE WEBHOOK START ==========`);
    this.logger.log(`Webhook ID: ${webhookId}`);
    this.logger.log(`Request URL: ${req.protocol}://${req.get('host')}${req.originalUrl}`);
    this.logger.log(`Payload: ${JSON.stringify(payload, null, 2)}`);
    this.logger.log(`Signature present: ${!!signature}`);

    const workspace = await this.twilioWebhooksService.getWorkspaceByWebhookId(webhookId);

    if (!workspace) {
      this.logger.error(`Invalid webhook URL - workspace not found for ${webhookId}`);
      throw new NotFoundException('Invalid webhook URL');
    }

    this.logger.log(`Found workspace: ${workspace.id} (${workspace.name})`);

    // Verify Twilio signature
    if (signature) {
      const authToken = await this.twilioWebhooksService.getAuthToken(workspace.id);
      if (authToken) {
        const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
        this.logger.log(`Signature verification - URL: ${fullUrl}`);
        this.logger.log(`Signature verification - Signature: ${signature}`);

        const isValid = this.twilioWebhooksService.verifyTwilioSignature(
          authToken,
          signature,
          fullUrl,
          payload as unknown as Record<string, string>,
        );

        if (!isValid) {
          this.logger.warn('⚠️ Invalid Twilio voice signature - TEMPORARILY ALLOWING for debugging');
          // throw new BadRequestException('Invalid webhook signature');
          // TODO: Re-enable signature verification after debugging
        } else {
          this.logger.log('✅ Twilio signature verified successfully');
        }
      } else {
        this.logger.warn('Auth token not found for signature verification');
      }
    } else {
      this.logger.warn('No signature provided in request');
    }

    let twiml: string;

    // Check if this is an outgoing call from the browser (Voice SDK)
    // When device.connect() is called with params {To, From}, Twilio sends those as part of the payload
    if (payload.To && payload.From) {
      // This is an outgoing call from the browser
      this.logger.log(`>>> DETECTED: Outgoing call from browser`);
      this.logger.log(`>>> From: ${payload.From}, To: ${payload.To}, CallSid: ${payload.CallSid}`);
      twiml = await this.twilioWebhooksService.handleOutgoingCall(workspace.id, payload);
    } else {
      // This is an incoming call to a Twilio number
      this.logger.log(`>>> DETECTED: Incoming call to workspace`);
      this.logger.log(`>>> Called: ${payload.Called || payload.To}, From: ${payload.From}, CallSid: ${payload.CallSid}`);
      twiml = await this.twilioWebhooksService.handleIncomingCall(workspace.id, payload);
    }

    this.logger.log(`Generated TwiML (length: ${twiml.length} chars):`);
    this.logger.log(twiml);
    this.logger.log(`========== TWILIO VOICE WEBHOOK END ==========`);

    // Return TwiML response
    res.set('Content-Type', 'text/xml');
    res.send(twiml);
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
}
