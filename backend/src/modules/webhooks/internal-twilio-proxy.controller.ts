/**
 * Internal service-to-service endpoint for streaming Twilio recordings on
 * behalf of downstream products (LeadBridge, dashboards, etc.).
 *
 * Why this exists:
 * Sigcore stores Twilio Account SID + Auth Token per workspace/tenant, encrypted
 * with the platform ENCRYPTION_KEY, in `communication_integrations.credentials_encrypted`.
 * Downstream products can't decrypt those creds, so raw Twilio recording URLs
 * (which require HTTP Basic Auth) are unplayable from any other service or the
 * browser. This proxy applies the auth here — creds never leave Sigcore — and
 * streams the audio to the caller.
 *
 * Auth: `x-sigcore-key` header must equal env `SIGCORE_SERVICE_KEY`.
 * Unlike `SigcoreAuthGuard` we do NOT require `x-workspace-id` — the workspace
 * is resolved from the Account SID embedded in the Twilio URL, so callers only
 * need the URL itself.
 *
 * Request:  GET /api/internal/twilio/recording-proxy?url=<url-encoded twilio recording url>
 * Response: audio/mpeg stream, or 4xx JSON.
 */
import {
  Controller,
  Get,
  Query,
  Res,
  Req,
  BadRequestException,
  UnauthorizedException,
  NotFoundException,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import axios, { AxiosError } from 'axios';
import { CommunicationIntegration, ProviderType } from '../../database/entities';
import { EncryptionService } from '../../common/services/encryption.service';

const TWILIO_URL_ACCOUNT_SID = /\/Accounts\/(AC[a-f0-9]{32})\//i;
const TWILIO_ORIGIN = 'https://api.twilio.com';

interface TwilioCreds {
  accountSid: string;
  authToken: string;
}

@Controller('internal/twilio')
export class InternalTwilioProxyController {
  private readonly logger = new Logger(InternalTwilioProxyController.name);

  constructor(
    @InjectRepository(CommunicationIntegration)
    private readonly integrationRepo: Repository<CommunicationIntegration>,
    private readonly encryptionService: EncryptionService,
    private readonly configService: ConfigService,
  ) {}

  @Get('recording-proxy')
  async streamRecording(
    @Query('url') url: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const expected = this.configService.get<string>('SIGCORE_SERVICE_KEY');
    const provided = req.headers['x-sigcore-key'];
    if (!expected || !provided || provided !== expected) {
      throw new UnauthorizedException('Invalid or missing x-sigcore-key');
    }

    if (!url) throw new BadRequestException('Query param `url` is required');
    if (!url.startsWith(TWILIO_ORIGIN)) {
      throw new BadRequestException('URL must be a Twilio recording URL');
    }
    const acctMatch = TWILIO_URL_ACCOUNT_SID.exec(url);
    if (!acctMatch) throw new BadRequestException('URL does not contain a Twilio Account SID');
    const accountSid = acctMatch[1];

    const creds = await this.resolveCredsForAccount(accountSid);
    if (!creds) {
      this.logger.warn(`[recording-proxy] No integration found for accountSid=${accountSid}`);
      throw new NotFoundException(`No Twilio integration for account ${accountSid}`);
    }

    try {
      const upstream = await axios.get(url, {
        responseType: 'stream',
        auth: { username: creds.accountSid, password: creds.authToken },
        // Follow Twilio's occasional 302 redirects to the media host
        maxRedirects: 5,
        // Don't blow up on 4xx — pass through the status code so LB can render
        // a sensible error instead of 500ing on a stale URL.
        validateStatus: () => true,
        timeout: 30_000,
      });

      const contentType = upstream.headers['content-type'] || 'audio/mpeg';
      const contentLength = upstream.headers['content-length'];

      res.status(upstream.status);
      res.setHeader('Content-Type', contentType);
      if (contentLength) res.setHeader('Content-Length', contentLength);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('Accept-Ranges', 'bytes');

      upstream.data.pipe(res);
    } catch (err) {
      const axiosErr = err as AxiosError;
      this.logger.error(
        `[recording-proxy] Twilio fetch failed for account ${accountSid}: ` +
          `${axiosErr.response?.status ?? '?'} ${axiosErr.message}`,
      );
      throw new InternalServerErrorException('Failed to fetch recording from Twilio');
    }
  }

  /**
   * Find the CommunicationIntegration whose decrypted creds match the given
   * Twilio Account SID. Iterates every TWILIO-provider integration and
   * decrypts — no queryable accountSid column exists today. In practice the
   * candidate set is O(tenants-with-Twilio), which is small; when scale
   * matters we can add a plaintext `provider_account_id` column and index on it.
   */
  private async resolveCredsForAccount(accountSid: string): Promise<TwilioCreds | null> {
    const rows = await this.integrationRepo.find({
      where: { provider: ProviderType.TWILIO },
      select: ['id', 'workspaceId', 'credentialsEncrypted'],
    });
    for (const row of rows) {
      if (!row.credentialsEncrypted) continue;
      try {
        const decrypted = this.encryptionService.decrypt(row.credentialsEncrypted);
        const parsed = JSON.parse(decrypted) as Partial<TwilioCreds>;
        if (parsed?.accountSid === accountSid && parsed.authToken) {
          return { accountSid: parsed.accountSid, authToken: parsed.authToken };
        }
      } catch {
        // corrupt row — skip
      }
    }
    return null;
  }
}
