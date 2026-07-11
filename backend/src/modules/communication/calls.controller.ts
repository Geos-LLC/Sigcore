import {
  Controller,
  Get,
  Post,
  Param,
  Body,
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
import { CommunicationService } from './communication.service';
import { TwilioVoiceService } from './twilio-voice.service';
import { SigcoreAuthGuard } from '../auth/sigcore-auth.guard';
import { WorkspaceId } from '../auth/decorators/workspace-id.decorator';
import { RequiresTenantScope } from '../auth/decorators/require-tenant-scope.decorator';
import { UseIntegrationResourceGuard } from '../../common/guards/use-integration-resource-guard.decorator';
import { IntegrationResourceGuardResult } from '../../common/guards/integration-resource-guard.service';
import { RecordingStartDto, HangupDto } from './dto/call-ops.dto';

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
  constructor(private readonly twilioVoiceService: TwilioVoiceService) {}

  @Post(':providerCallSid/recording/start')
  @HttpCode(HttpStatus.OK)
  @UseIntegrationResourceGuard('providerCallSid')
  async startRecording(
    @Param('providerCallSid') providerCallSid: string,
    @Body() dto: RecordingStartDto,
    @Req() req: Request & { resource?: IntegrationResourceGuardResult },
  ) {
    const resource = req.resource!;
    const result = await this.twilioVoiceService.startRecording(
      resource.integration,
      providerCallSid,
      {
        recordingChannels: dto.recordingChannels,
        statusCallbackUrl: dto.statusCallbackUrl,
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
