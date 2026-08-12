import { Injectable, Logger, BadGatewayException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as twilio from 'twilio';
import { CommunicationIntegration } from '../../database/entities/communication-integration.entity';
import { EncryptionService } from '../../common/services/encryption.service';
import { RecordingStartDto, RecordingStartResult, HangupResult, DialCallResult } from './dto/call-ops.dto';

const AccessToken = twilio.jwt.AccessToken;
const VoiceGrant = AccessToken.VoiceGrant;

@Injectable()
export class TwilioVoiceService {
  private readonly logger = new Logger(TwilioVoiceService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly encryptionService: EncryptionService,
  ) {}

  // ==================== WAVE-2 TASK 3 — OPS SURFACE ====================

  /**
   * Start a Twilio call recording. Called from the new v1 route
   * `POST /v1/calls/:providerCallSid/recording/start` after
   * IntegrationResourceGuard has verified the caller owns the call+integration.
   *
   * This method never accepts raw credentials from the request — the
   * integration row is resolved by the guard and passed in. Twilio failures
   * surface as 502 (BadGatewayException) rather than 500 so operators can
   * distinguish "provider misbehaved" from "our code crashed".
   */
  async startRecording(
    integration: CommunicationIntegration,
    providerCallSid: string,
    opts?: Pick<RecordingStartDto, 'recordingChannels' | 'statusCallbackUrl' | 'statusCallbackEvents'>,
  ): Promise<RecordingStartResult> {
    const client = this.clientForIntegration(integration);
    try {
      const rec = await client.calls(providerCallSid).recordings.create({
        recordingChannels: opts?.recordingChannels ?? 'dual',
        recordingStatusCallback: opts?.statusCallbackUrl,
        recordingStatusCallbackEvent: opts?.statusCallbackEvents,
      } as any);
      this.logger.log(
        `[startRecording] ok providerCallSid=${providerCallSid} recordingSid=${rec.sid} status=${rec.status}`,
      );
      return { recordingSid: rec.sid, status: rec.status ?? 'unknown' };
    } catch (err: any) {
      this.logger.error(
        `[startRecording] Twilio error providerCallSid=${providerCallSid}: ${err?.message}`,
      );
      throw new BadGatewayException(
        `Twilio startRecording failed: ${err?.message ?? 'unknown error'}`,
      );
    }
  }

  /**
   * Wave-2 Phase C — outbound dial.
   *
   * Creates an outbound Twilio call under the integration's stored
   * credentials. Caller (v1 dial route) must have already:
   *   1. Verified fromNumber ownership via tenant_phone_numbers lookup
   *   2. Wrapped `statusCallbackUrl` in a Sigcore signed callback token
   *      (so Twilio dials Sigcore first, not Callio)
   *   3. Constructed a Sigcore-hosted `answerUrl` that returns the
   *      appropriate TwiML when the call is answered
   */
  async dialOutbound(
    integration: CommunicationIntegration,
    input: {
      fromNumber: string;
      toNumber: string;
      answerUrl: string;
      statusCallbackUrl?: string;
      recordingChannels?: 'mono' | 'dual';
      timeoutSeconds?: number;
    },
  ): Promise<DialCallResult> {
    const client = this.clientForIntegration(integration);
    try {
      const params: any = {
        from: input.fromNumber,
        to: input.toNumber,
        url: input.answerUrl,
        method: 'POST',
        timeout: input.timeoutSeconds ?? 30,
        record: true,
        recordingChannels: input.recordingChannels ?? 'dual',
      };
      // NOTE: machineDetection was set to 'Enable' briefly (commit
      // bff87fc3) so MockCustomer's whisper-bridge could short-circuit
      // voicemail answers. Reverted 2026-08-12 after operator report:
      // Twilio's AMD over-classified iOS-Call-Screening answers +
      // brief-hesitation human answers as 'machine_start', triggering
      // the short-circuit hangup on legitimate calls (visitor's phone
      // showed a missed call and rolled to voicemail from the
      // hang-up event, not from the carrier). Callers that need AMD
      // should opt in explicitly via input flag rather than making
      // it dial-wide.

      if (input.statusCallbackUrl) {
        params.statusCallback = input.statusCallbackUrl;
        params.statusCallbackMethod = 'POST';
        // Ask Twilio for the full lifecycle set, not just the completed default.
        params.statusCallbackEvent = ['initiated', 'ringing', 'answered', 'completed'];
      }
      const call = await client.calls.create(params);
      this.logger.log(
        `[dialOutbound] ok providerCallSid=${call.sid} from=${input.fromNumber} to=${input.toNumber} status=${call.status}`,
      );
      return {
        providerCallSid: call.sid,
        status: call.status ?? 'queued',
        fromNumber: input.fromNumber,
        toNumber: input.toNumber,
        createdAt: call.dateCreated ? new Date(call.dateCreated).toISOString() : new Date().toISOString(),
        integrationId: integration.id,
      };
    } catch (err: any) {
      this.logger.error(
        `[dialOutbound] Twilio error from=${input.fromNumber} to=${input.toNumber}: ${err?.message}`,
      );
      throw new BadGatewayException(
        `Twilio dial failed: ${err?.message ?? 'unknown error'}`,
      );
    }
  }

  /**
   * Hang up an in-progress Twilio call. Called from the new v1 route
   * `POST /v1/calls/:providerCallSid/hangup` after IntegrationResourceGuard
   * has verified the caller owns the call+integration.
   */
  async hangup(
    integration: CommunicationIntegration,
    providerCallSid: string,
  ): Promise<HangupResult> {
    const client = this.clientForIntegration(integration);
    try {
      await client.calls(providerCallSid).update({ status: 'completed' } as any);
      this.logger.log(`[hangup] ok providerCallSid=${providerCallSid}`);
      return { providerCallSid, status: 'completed' };
    } catch (err: any) {
      this.logger.error(
        `[hangup] Twilio error providerCallSid=${providerCallSid}: ${err?.message}`,
      );
      throw new BadGatewayException(
        `Twilio hangup failed: ${err?.message ?? 'unknown error'}`,
      );
    }
  }

  /**
   * Decrypt an integration's credentials and instantiate a Twilio SDK client.
   * Split out so both startRecording and hangup share the same code path — do
   * NOT reach into this from the existing generateAccessToken / TwiML methods,
   * which take pre-decoded credentials from IntegrationsService.
   */
  private clientForIntegration(integration: CommunicationIntegration): twilio.Twilio {
    const decrypted = this.encryptionService.decrypt(integration.credentialsEncrypted);
    const creds = JSON.parse(decrypted);
    if (!creds.accountSid || !creds.authToken) {
      throw new BadGatewayException(
        'Integration credentials missing accountSid/authToken for Twilio ops',
      );
    }
    return new twilio.Twilio(creds.accountSid, creds.authToken);
  }

  /**
   * Generate a Twilio Voice access token for browser-based calling
   */
  generateAccessToken(
    identity: string,
    accountSid: string,
    apiKey: string,
    apiSecret: string,
    twimlAppSid: string,
  ): string {
    this.logger.log(`========== GENERATING VOICE TOKEN ==========`);
    this.logger.log(`Identity: ${identity}`);
    this.logger.log(`Account SID: ${accountSid}`);
    this.logger.log(`API Key: ${apiKey}`);
    this.logger.log(`TwiML App SID: ${twimlAppSid}`);

    if (!accountSid || !apiKey || !apiSecret || !twimlAppSid) {
      throw new Error('Twilio voice credentials not configured');
    }

    // Create an access token
    const token = new AccessToken(accountSid, apiKey, apiSecret, {
      identity,
      ttl: 3600, // 1 hour
    });

    // Create a Voice grant
    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: twimlAppSid,
      incomingAllow: true,
    });

    // Add the grant to the token
    token.addGrant(voiceGrant);

    this.logger.log(`✅ Voice token generated successfully`);
    this.logger.log(`Token will route calls to TwiML App: ${twimlAppSid}`);
    this.logger.log(`========== VOICE TOKEN GENERATION COMPLETE ==========`);

    return token.toJwt();
  }

  /**
   * Generate TwiML for outgoing calls
   */
  generateOutgoingCallTwiML(to: string, from: string, callerId?: string): string {
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();

    const dial = response.dial({
      callerId: callerId || from,
      answerOnBridge: true,
      record: 'record-from-answer-dual',
      recordingStatusCallback: `${this.configService.get<string>('API_URL')}/api/webhooks/twilio/recording-status`,
    });

    dial.number(to);

    return response.toString();
  }

  /**
   * Generate TwiML for incoming calls
   */
  generateIncomingCallTwiML(): string {
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();

    response.say('Incoming call. Please wait while we connect you.');

    // You can add more logic here for routing incoming calls
    // For now, we'll just play a message
    response.pause({ length: 1 });

    return response.toString();
  }
}
