import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Headers,
  Query,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { createReadStream, existsSync, statSync } from 'fs';
import { extname } from 'path';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommunicationService } from './communication.service';
import { TwilioVoiceService } from './twilio-voice.service';
import { SigcoreAuthGuard } from '../auth/sigcore-auth.guard';
import { WorkspaceId } from '../auth/decorators/workspace-id.decorator';
import { RequiresTenantScope } from '../auth/decorators/require-tenant-scope.decorator';
import { UseIntegrationResourceGuard } from '../../common/guards/use-integration-resource-guard.decorator';
import { IntegrationResourceGuardResult } from '../../common/guards/integration-resource-guard.service';
import { IntegrationResourceGuardService } from '../../common/guards/integration-resource-guard.service';
import { RecordingStartDto, HangupDto, DialCallDto } from './dto/call-ops.dto';
import { CallbackForwarderService } from '../webhooks/callback-forwarder.service';
import { DialIdempotencyService } from './dial-idempotency.service';
import { TenantPhoneNumber } from '../../database/entities/tenant-phone-number.entity';
import { tpnSupportsChannel } from '../../common/util/tpn-channel';

const E164_REGEX = /^\+[1-9]\d{6,14}$/;

// Map file extensions to MIME types
const AUDIO_MIME_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.webm': 'audio/webm',
};

function getContentType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return AUDIO_MIME_TYPES[ext] || 'audio/mpeg';
}

@Controller('calls')
@UseGuards(SigcoreAuthGuard)
// @RequiresTenantScope() // TODO: re-enable after TypeORM tenant_id fix
export class CallsController {
  constructor(private readonly communicationService: CommunicationService) {}

  /**
   * Get call details by ID
   */
  @Get(':callId')
  async getCall(
    @Param('callId') callId: string,
    @WorkspaceId() workspaceId: string,
  ) {
    const call = await this.communicationService.getCall(workspaceId, callId);
    return { data: call };
  }

  /**
   * Get transcript for a call.
   * Fetches from OpenPhone and caches it.
   */
  @Get(':callId/transcript')
  async getTranscript(
    @Param('callId') callId: string,
    @WorkspaceId() workspaceId: string,
  ) {
    const result = await this.communicationService.getCallTranscript(workspaceId, callId);
    return { data: result };
  }

  /**
   * Get OpenPhone Sona AI summary + next steps for a call.
   * Thin proxy — not cached on Sigcore side. Consumers (LB) cache.
   * Response shape: { data: { status: 'completed'|'absent'|'in_progress'|'error',
   *                            summary: string[], nextSteps: string[] } }
   */
  @Get(':callId/summary')
  async getSummary(
    @Param('callId') callId: string,
    @WorkspaceId() workspaceId: string,
  ) {
    const result = await this.communicationService.getCallSummary(workspaceId, callId);
    return { data: result };
  }

  /**
   * Fetch recording URLs for a call from OpenPhone.
   * This is needed because OpenPhone stores recordings separately.
   */
  @Get(':callId/recordings')
  async getRecordings(
    @Param('callId') callId: string,
    @WorkspaceId() workspaceId: string,
  ) {
    const result = await this.communicationService.fetchCallRecordings(workspaceId, callId);
    return { data: result };
  }

  /**
   * Download and cache a call recording locally.
   * Returns the URL to stream the recording.
   */
  @Post(':callId/recording/download')
  @HttpCode(HttpStatus.OK)
  async downloadRecording(
    @Param('callId') callId: string,
    @WorkspaceId() workspaceId: string,
  ) {
    const result = await this.communicationService.downloadCallRecording(
      workspaceId,
      callId,
      'recording',
    );
    return { data: result };
  }

  /**
   * Download and cache a voicemail locally.
   * Returns the URL to stream the voicemail.
   */
  @Post(':callId/voicemail/download')
  @HttpCode(HttpStatus.OK)
  async downloadVoicemail(
    @Param('callId') callId: string,
    @WorkspaceId() workspaceId: string,
  ) {
    const result = await this.communicationService.downloadCallRecording(
      workspaceId,
      callId,
      'voicemail',
    );
    return { data: result };
  }

  /**
   * Stream a locally cached recording.
   */
  @Get(':callId/recording/stream')
  async streamRecording(
    @Param('callId') callId: string,
    @WorkspaceId() workspaceId: string,
    @Res() res: Response,
  ) {
    const call = await this.communicationService.getCall(workspaceId, callId);

    if (!call.localRecordingPath || !existsSync(call.localRecordingPath)) {
      throw new NotFoundException('Recording not downloaded yet');
    }

    const contentType = getContentType(call.localRecordingPath);
    const stat = statSync(call.localRecordingPath);

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Accept-Ranges', 'bytes');

    const stream = createReadStream(call.localRecordingPath);
    stream.pipe(res);
  }

  /**
   * Stream a locally cached voicemail.
   */
  @Get(':callId/voicemail/stream')
  async streamVoicemail(
    @Param('callId') callId: string,
    @WorkspaceId() workspaceId: string,
    @Res() res: Response,
  ) {
    const call = await this.communicationService.getCall(workspaceId, callId);

    if (!call.localVoicemailPath || !existsSync(call.localVoicemailPath)) {
      throw new NotFoundException('Voicemail not downloaded yet');
    }

    const contentType = getContentType(call.localVoicemailPath);
    const stat = statSync(call.localVoicemailPath);

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Accept-Ranges', 'bytes');

    const stream = createReadStream(call.localVoicemailPath);
    stream.pipe(res);
  }

  /**
   * Download recording file directly from OpenPhone and send to client.
   * This fetches from OpenPhone, doesn't cache locally.
   */
  @Get(':callId/recording/file')
  async downloadRecordingFile(
    @Param('callId') callId: string,
    @WorkspaceId() workspaceId: string,
    @Res() res: Response,
  ) {
    const audioBuffer = await this.communicationService.getRecordingBuffer(
      workspaceId,
      callId,
      'recording',
    );

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audioBuffer.length);
    res.setHeader('Content-Disposition', `attachment; filename="recording_${callId}.mp3"`);

    res.send(audioBuffer);
  }

  /**
   * Download voicemail file directly from OpenPhone and send to client.
   * This fetches from OpenPhone, doesn't cache locally.
   */
  @Get(':callId/voicemail/file')
  async downloadVoicemailFile(
    @Param('callId') callId: string,
    @WorkspaceId() workspaceId: string,
    @Res() res: Response,
  ) {
    const audioBuffer = await this.communicationService.getRecordingBuffer(
      workspaceId,
      callId,
      'voicemail',
    );

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audioBuffer.length);
    res.setHeader('Content-Disposition', `attachment; filename="voicemail_${callId}.mp3"`);

    res.send(audioBuffer);
  }
}

/**
 * Wave-2 Task 3 — v1 call ops surface.
 *
 * Two Sigcore-owned operations Callio will call after the Task 6 flag flip:
 *   POST /v1/calls/:providerCallSid/recording/start
 *   POST /v1/calls/:providerCallSid/hangup
 *
 * Both routes stack SigcoreAuthGuard (workspaceId/tenantId population) with
 * @UseIntegrationResourceGuard('providerCallSid'), which runs the 4-way
 * validation and attaches the resolved integration to request.resource.
 * The route handler grabs that integration and delegates to
 * TwilioVoiceService — the guard is the ONLY place where authorization is
 * checked.
 *
 * The existing `/calls/:callId/*` routes above are untouched; this controller
 * lives at a different path prefix so no route registration is replaced.
 */
@Controller('v1/calls')
@UseGuards(SigcoreAuthGuard)
export class CallsV1Controller {
  constructor(
    private readonly twilioVoiceService: TwilioVoiceService,
    private readonly callbackForwarder: CallbackForwarderService,
    private readonly configService: ConfigService,
    private readonly dialIdempotency: DialIdempotencyService,
    private readonly integrationResourceGuard: IntegrationResourceGuardService,
    @InjectRepository(TenantPhoneNumber)
    private readonly tpnRepo: Repository<TenantPhoneNumber>,
  ) {}

  /**
   * Wave-2 Phase C — outbound dial.
   *
   * POST /api/v1/calls/dial creates a Twilio outbound call under the
   * calling tenant's phone number. Guard: IntegrationResourceGuardService
   * validates (workspace, tenant, integration) — 4-way check w/o the
   * providerCallSid variant since we don't yet have a call to check. The
   * fromNumber lookup is done inline against tenant_phone_numbers to
   * prevent cross-workspace / cross-tenant caller-ID use.
   *
   * Idempotency-Key header is required. The store returns:
   *   new       → proceed, dial, remember response
   *   match     → return the prior response byte-for-byte
   *   conflict  → same key + different body → 409 Conflict
   *
   * The statusCallbackUrl from the DTO is wrapped in a Sigcore-signed
   * callback token so Twilio dials Sigcore first, not Callio (same
   * pattern used by recording/start in Phase B / Task 6B.5C).
   *
   * The Twilio call's `url` (answer TwiML) is a Sigcore-hosted endpoint
   * that returns TwiML based on `answerMode`:
   *   hangup     → `<Response><Hangup/></Response>`
   *   twiml_url  → `<Response><Redirect method="POST">{answerTwimlUrl}</Redirect></Response>`
   */
  @Post('dial')
  @HttpCode(HttpStatus.OK)
  async dial(
    @Body() dto: DialCallDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request & { workspaceId?: string; tenantId?: string; authType?: string; authScopeType?: string },
  ) {
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw new BadRequestException('Idempotency-Key header required (8-128 chars)');
    }
    if (!E164_REGEX.test(dto.fromNumber)) {
      throw new BadRequestException('fromNumber must be E.164');
    }
    if (!E164_REGEX.test(dto.toNumber)) {
      throw new BadRequestException('toNumber must be E.164');
    }
    if (dto.answerMode === 'twiml_url' && !dto.answerTwimlUrl) {
      throw new BadRequestException('answerTwimlUrl required when answerMode=twiml_url');
    }
    if (dto.answerMode === 'media_stream') {
      if (!dto.mediaStreamWssBaseUrl) {
        throw new BadRequestException('mediaStreamWssBaseUrl required when answerMode=media_stream');
      }
      if (!dto.callioCallId) {
        throw new BadRequestException('callioCallId required when answerMode=media_stream');
      }
      // Basic wss:// validation. Sigcore refuses to hand Twilio a URL
      // scheme that isn't a WebSocket. (ws:// permitted only in dev.)
      const isProd = (this.configService.get<string>('NODE_ENV') ?? 'production') === 'production';
      if (isProd) {
        if (!/^wss:\/\//i.test(dto.mediaStreamWssBaseUrl)) {
          throw new BadRequestException('mediaStreamWssBaseUrl must be wss:// in production');
        }
      } else {
        if (!/^(wss|ws):\/\//i.test(dto.mediaStreamWssBaseUrl)) {
          throw new BadRequestException('mediaStreamWssBaseUrl must be ws:// or wss://');
        }
      }
    }
    if (dto.timeoutSeconds !== undefined) {
      if (typeof dto.timeoutSeconds !== 'number' || dto.timeoutSeconds < 5 || dto.timeoutSeconds > 600) {
        throw new BadRequestException('timeoutSeconds must be number between 5 and 600');
      }
    }

    // Run the 3-of-4 guard checks (workspace, tenant, integration). Skip
    // check-4 (resource link) since we're CREATING the call — no
    // providerCallSid exists yet.
    const { workspaceId, tenantId, integration } = await this.integrationResourceGuard.assert({
      request: {
        workspaceId: req.workspaceId,
        tenantId: req.tenantId,
        authType: req.authType,
        authScopeType: req.authScopeType,
        body: { tenantId: dto.tenantId },
      },
      integrationId: dto.integrationId,
    });

    // Caller-ID ownership — fromNumber must be a tenant_phone_numbers row
    // owned by (workspaceId, tenantId) with a voice channel.
    const tpn = await this.tpnRepo.findOne({
      where: { workspaceId, phoneNumber: dto.fromNumber, tenantId },
    });
    if (!tpn) {
      throw new ForbiddenException(
        'fromNumber not owned by (workspace, tenant) — cross-workspace caller ID rejected',
      );
    }
    // Voice-capability check. Historical shape: `both` purchases store
    // `channel = SMS` in the enum column with the full intent in
    // `metadata.activeChannels = ['sms','voice']`. Read metadata as the
    // source of truth; fall back to the column for pre-Wave-2 rows.
    // See common/util/tpn-channel.ts for the full history.
    if (!tpnSupportsChannel(tpn, 'voice')) {
      throw new BadRequestException(
        `fromNumber ${dto.fromNumber} does not support the voice channel ` +
          `(activeChannels=${JSON.stringify(
            (tpn.metadata as { activeChannels?: unknown } | null | undefined)
              ?.activeChannels ?? tpn.channel,
          )})`,
      );
    }
    if (String(tpn.provider) !== String(integration.provider)) {
      throw new BadRequestException(
        'fromNumber provider does not match integration provider',
      );
    }

    // Idempotency claim (in-process, TTL 24h).
    const bodyHash = DialIdempotencyService.hashBody(dto);
    const claim = this.dialIdempotency.claim(workspaceId, idempotencyKey, bodyHash);
    if (claim.status === 'match') {
      return { data: claim.response };
    }
    if (claim.status === 'conflict') {
      throw new ConflictException(
        'Idempotency-Key reused with a different request body',
      );
    }

    // Build the Sigcore-hosted answer URL. The answer route is public and
    // stateless — it derives its TwiML from query params. Twilio hits it
    // when the destination picks up.
    const publicBase: string | undefined =
      this.configService.get<string>('PUBLIC_BASE_URL') ||
      (process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : undefined);
    if (!publicBase) {
      this.dialIdempotency.release(workspaceId, idempotencyKey);
      throw new BadRequestException(
        'Sigcore PUBLIC_BASE_URL not configured — cannot construct outbound answer URL',
      );
    }
    const answerMode = dto.answerMode ?? 'hangup';
    let answerUrl: string;
    if (answerMode === 'media_stream') {
      // Phase C.2 — mint a signed single-use session token that the
      // outbound-answer route redeems into <Connect><Stream/></Connect>
      // TwiML. Token binds everything Callio's WSS handler needs to
      // authenticate the connection AND find the pre-created voice_calls
      // row without a DB roundtrip.
      const token = this.callbackForwarder.mintToken({
        kind: 'media_session' as any,
        sigcoreWorkspaceId: workspaceId,
        sigcoreTenantId: tenantId,
        // Reuse the callioDestUrl field to carry the WSS base URL.
        // Callio's verifier reads this to whitelist the destination and
        // returns it back in its own decoded payload — no free-form URLs.
        callioDestUrl: dto.mediaStreamWssBaseUrl!,
        callioCallId: dto.callioCallId!,
        // Phase C.2 fields — providerCallSid + integrationId. The
        // providerCallSid isn't known until after Twilio returns from
        // client.calls.create, so we bake it in AFTER dial. We mint an
        // "unbound" token now with just the callioCallId, integration,
        // workspace/tenant; the outbound-answer route re-mints a
        // providerCallSid-bound token when it serves the TwiML. This
        // narrows the reuse window: even a leaked outer token can only
        // be redeemed by Twilio pinging the exact answer-URL Sigcore
        // built for THIS call. The inner (WSS-facing) token is what
        // Callio actually verifies + burns.
        integrationId: dto.integrationId,
        // TTL 1h — Twilio call-answer typically fires within seconds;
        // 1h covers the worst case (destination lets it ring the full
        // timeoutSeconds, plus buffer).
        ttlSeconds: 3600,
      });
      if (!token) {
        this.dialIdempotency.release(workspaceId, idempotencyKey);
        throw new BadRequestException(
          'Sigcore callback forwarder HMAC secret not configured — media_stream mode requires SIGCORE_VOICE_FORWARD_HMAC_SECRET',
        );
      }
      answerUrl = `${publicBase.replace(/\/$/, '')}/api/webhooks/twilio/voice/outbound-answer/${token}`;
    } else {
      const answerParams = new URLSearchParams({ mode: answerMode });
      if (answerMode === 'twiml_url' && dto.answerTwimlUrl) {
        answerParams.set('url', dto.answerTwimlUrl);
      }
      answerUrl = `${publicBase.replace(/\/$/, '')}/api/webhooks/twilio/voice/outbound-answer?${answerParams.toString()}`;
    }

    // Wrap statusCallbackUrl in a Sigcore signed token so Twilio dials
    // Sigcore first for status events, mirroring the recording-status
    // wrapping in Task 6B.5C.
    let wrappedStatusUrl: string | undefined;
    if (dto.statusCallbackUrl && this.callbackForwarder.isArmed()) {
      const token = this.callbackForwarder.mintToken({
        kind: 'call_status',
        sigcoreWorkspaceId: workspaceId,
        sigcoreTenantId: tenantId,
        callioDestUrl: dto.statusCallbackUrl,
      });
      if (token) {
        wrappedStatusUrl = `${publicBase.replace(/\/$/, '')}/api/webhooks/twilio/status/${token}`;
      }
    }

    // Fire the actual Twilio call. Any Twilio-side failure surfaces as
    // 502 (BadGatewayException) and releases the idempotency slot so the
    // caller can retry with the same key.
    let result;
    try {
      result = await this.twilioVoiceService.dialOutbound(integration, {
        fromNumber: dto.fromNumber,
        toNumber: dto.toNumber,
        answerUrl,
        statusCallbackUrl: wrappedStatusUrl,
        recordingChannels: dto.recordingChannels,
        timeoutSeconds: dto.timeoutSeconds,
      });
    } catch (err) {
      this.dialIdempotency.release(workspaceId, idempotencyKey);
      throw err;
    }

    this.dialIdempotency.remember(workspaceId, idempotencyKey, bodyHash, result);
    return { data: result };
  }

  @Post(':providerCallSid/recording/start')
  @HttpCode(HttpStatus.OK)
  @UseIntegrationResourceGuard('providerCallSid')
  async startRecording(
    @Param('providerCallSid') providerCallSid: string,
    @Body() dto: RecordingStartDto,
    @Req() req: Request & {
      resource?: IntegrationResourceGuardResult;
      body?: { tenantId?: string };
    },
  ) {
    const resource = req.resource!;
    // Task 6B.5C — wrap the Callio-side statusCallbackUrl in a Sigcore-owned
    // token URL BEFORE handing it to Twilio. Twilio then calls Sigcore's
    // /webhooks/twilio/recording-status/:token route; Sigcore verifies
    // Twilio's signature against the subaccount, HMAC-signs the envelope,
    // and forwards to Callio (dto.statusCallbackUrl, embedded in the token).
    //
    // If the caller did not provide statusCallbackUrl, or Sigcore's HMAC
    // secret is not configured, we pass the URL through unchanged — the
    // pre-6B.5C direct-Twilio path is preserved.
    let statusCallbackUrl = dto.statusCallbackUrl;
    if (statusCallbackUrl && this.callbackForwarder.isArmed()) {
      const bodyTenantId =
        (req.body && req.body.tenantId) || undefined;
      const sigcoreTenantId =
        bodyTenantId ??
        ((resource.integration.metadata as Record<string, unknown> | null)?.[
          'ensure'
        ] as Record<string, unknown> | undefined)?.['tenantId'] as string | undefined;
      if (sigcoreTenantId) {
        const token = this.callbackForwarder.mintToken({
          kind: 'recording_status',
          sigcoreWorkspaceId: resource.integration.workspaceId,
          sigcoreTenantId,
          callioDestUrl: statusCallbackUrl,
          // The recording callback route on Callio embeds a callId in the
          // URL path; that path is preserved verbatim inside the token so
          // Callio's own routing works unchanged.
        });
        if (token) {
          const publicBase: string | undefined =
            this.configService.get<string>('PUBLIC_BASE_URL') ||
            (process.env.RAILWAY_PUBLIC_DOMAIN
              ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
              : undefined);
          if (publicBase) {
            statusCallbackUrl = `${publicBase.replace(/\/$/, '')}/api/webhooks/twilio/recording-status/${token}`;
          }
        }
      }
    }

    const result = await this.twilioVoiceService.startRecording(
      resource.integration,
      providerCallSid,
      {
        recordingChannels: dto.recordingChannels,
        statusCallbackUrl: statusCallbackUrl as string | undefined,
        statusCallbackEvents: dto.statusCallbackEvents,
      },
    );
    return { data: result };
  }

  @Post(':providerCallSid/hangup')
  @HttpCode(HttpStatus.OK)
  @UseIntegrationResourceGuard('providerCallSid')
  async hangup(
    @Param('providerCallSid') providerCallSid: string,
    @Body() _dto: HangupDto,
    @Req() req: Request & { resource?: IntegrationResourceGuardResult },
  ) {
    const resource = req.resource!;
    const result = await this.twilioVoiceService.hangup(
      resource.integration,
      providerCallSid,
    );
    return { data: result };
  }
}
