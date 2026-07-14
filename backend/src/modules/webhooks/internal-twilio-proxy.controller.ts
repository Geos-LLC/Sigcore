/**
 * Internal service-to-service endpoint for streaming Twilio recordings on
 * behalf of downstream products (LeadBridge, dashboards, Callio voice).
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
 *
 * Two resolution modes:
 *
 *  1. **URL-scan mode (legacy)** — used by LeadBridge and dashboards. The
 *     caller supplies only `?url=`; Sigcore scans every TWILIO integration,
 *     decrypts creds until one whose accountSid matches the URL's Account
 *     SID is found. Backwards-compatible with pre-Task-6B.5D callers.
 *
 *  2. **Scoped mode (Task 6B.5D)** — used by Callio for voice recordings.
 *     The caller also supplies `x-sigcore-integration-id` +
 *     `x-sigcore-tenant-id` headers. Sigcore verifies the full ownership
 *     chain — workspace-owns-tenant, integration-belongs-to-workspace,
 *     integration.provider=TWILIO, integration.accountSid=URL-accountSid —
 *     BEFORE using the integration's stored credentials. Rejects with 403
 *     on any mismatch.
 *
 * Range: an incoming `Range` header is forwarded verbatim to Twilio. The
 * upstream status (200 full or 206 partial), `Content-Range`, and
 * `Accept-Ranges` are propagated ONLY if Twilio actually returns them —
 * never fabricated (Twilio's Recording resource does not currently support
 * range).
 *
 * Request:  GET /api/internal/twilio/recording-proxy?url=<url-encoded twilio recording url>
 * Response: audio/mpeg stream (200 or 206), or 4xx JSON.
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
  ForbiddenException,
  Logger,
  InternalServerErrorException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import axios, { AxiosError } from 'axios';
import {
  CommunicationIntegration,
  ProviderType,
  Tenant,
} from '../../database/entities';
import { EncryptionService } from '../../common/services/encryption.service';
import { ProviderContextResolver } from '../integrations/provider-context-resolver.service';

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
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    private readonly encryptionService: EncryptionService,
    private readonly configService: ConfigService,
    /**
     * Incident 2026-07-14 Phase 3a — cross-workspace integrationId hint
     * validation. When the caller supplies `x-sigcore-workspace-id`, the
     * resolver double-checks that `x-sigcore-integration-id` belongs to that
     * workspace before we hand out its Twilio credentials. Optional so the
     * two existing spec builders don't have to be rewritten in this PR.
     */
    @Optional()
    private readonly providerContextResolver?: ProviderContextResolver,
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
    const urlAccountSid = acctMatch[1];

    const integrationId = this.headerStr(req, 'x-sigcore-integration-id');
    const tenantId = this.headerStr(req, 'x-sigcore-tenant-id');
    // Incident 2026-07-14 Phase 3a — optional caller-provided workspace scope.
    // When present, the ProviderContextResolver validates that the supplied
    // integrationId hint actually belongs to that workspace BEFORE we decrypt
    // and return its Twilio credentials — closing the last cross-workspace
    // hint attack surface on the recording proxy. When absent, the pre-3a
    // scoped-mode checks still fire (integration.workspaceId ===
    // tenant.workspaceId and integration.accountSid === url.accountSid),
    // which prevent cross-workspace token disclosure UNLESS the caller
    // happens to supply an integrationId+tenantId pair from the same
    // *other* workspace — the remaining gap tightening this header closes.
    const callerWorkspaceId = this.headerStr(req, 'x-sigcore-workspace-id');

    let creds: TwilioCreds | null;
    if (integrationId && tenantId) {
      creds = await this.resolveCredsScoped({
        integrationId,
        tenantId,
        urlAccountSid,
        callerWorkspaceId,
      });
    } else {
      creds = await this.resolveCredsForAccount(urlAccountSid);
      if (!creds) {
        this.logger.warn(
          `[recording-proxy] URL-scan miss accountSid=${urlAccountSid}`,
        );
        throw new NotFoundException(
          `No Twilio integration for account ${urlAccountSid}`,
        );
      }
    }

    // Range: forward verbatim to Twilio. Don't fabricate anything.
    const forwardedHeaders: Record<string, string> = {};
    const range = req.headers.range;
    if (typeof range === 'string' && range.length > 0) {
      forwardedHeaders['Range'] = range;
    }

    let upstream;
    try {
      upstream = await axios.get(url, {
        responseType: 'stream',
        auth: { username: creds.accountSid, password: creds.authToken },
        // Follow Twilio's occasional 302 redirects to the media host
        maxRedirects: 5,
        // Don't blow up on 4xx — pass through the status code so callers can
        // render a sensible error instead of 500ing on a stale URL.
        validateStatus: () => true,
        timeout: 30_000,
        headers: forwardedHeaders,
      });
    } catch (err) {
      const axiosErr = err as AxiosError;
      this.logger.error(
        `[recording-proxy] Twilio fetch failed for account ${urlAccountSid}: ` +
          `${axiosErr.response?.status ?? '?'} ${axiosErr.message}`,
      );
      throw new InternalServerErrorException('Failed to fetch recording from Twilio');
    }

    // Propagate the upstream status verbatim. 200 for full audio, 206 for
    // partial (when Twilio ever supports Range). 401/404 pass through so the
    // browser sees the real Twilio error class.
    res.status(upstream.status);
    const contentType = upstream.headers['content-type'] || 'audio/mpeg';
    res.setHeader('Content-Type', contentType);
    const contentLength = upstream.headers['content-length'];
    if (contentLength) res.setHeader('Content-Length', String(contentLength));
    const contentRange = upstream.headers['content-range'];
    if (contentRange) res.setHeader('Content-Range', String(contentRange));
    const acceptRanges = upstream.headers['accept-ranges'];
    if (acceptRanges) res.setHeader('Accept-Ranges', String(acceptRanges));
    res.setHeader('Cache-Control', 'private, max-age=3600');

    upstream.data.pipe(res);
  }

  private headerStr(req: Request, name: string): string | undefined {
    const v = req.headers[name];
    if (typeof v === 'string') return v;
    if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
    return undefined;
  }

  /**
   * Task 6B.5D scoped mode. Verifies the full ownership chain and returns
   * the integration's decrypted Twilio credentials. Any mismatch → 403.
   *
   * Guard chain (in order — earliest possible rejection wins):
   *
   *   1. integration exists
   *   2. tenant exists
   *   3. integration.provider === TWILIO
   *   4. tenant.workspaceId === integration.workspaceId (workspace-owns-tenant
   *      AND integration-belongs-to-workspace collapse into this equality)
   *   5. integration.credentials decrypt → accountSid === url.accountSid
   *      (recording physically belongs to this integration's subaccount)
   *
   * Never surfaces the decrypted secret or Twilio auth token in errors/logs.
   */
  private async resolveCredsScoped(input: {
    integrationId: string;
    tenantId: string;
    urlAccountSid: string;
    callerWorkspaceId?: string;
  }): Promise<TwilioCreds> {
    const [integration, tenant] = await Promise.all([
      this.integrationRepo.findOne({ where: { id: input.integrationId } }),
      this.tenantRepo.findOne({ where: { id: input.tenantId } }),
    ]);
    if (!integration) {
      throw new NotFoundException('integration not found');
    }
    if (!tenant) {
      throw new NotFoundException('tenant not found');
    }
    if (integration.provider !== ProviderType.TWILIO) {
      throw new BadRequestException(
        `integration provider is ${integration.provider}, not twilio`,
      );
    }
    if (tenant.workspaceId !== integration.workspaceId) {
      this.logger.warn(
        `[recording-proxy] scope_denied reason=workspace_tenant_mismatch ` +
          `integrationId=${input.integrationId} tenantId=${input.tenantId} ` +
          `integrationWs=${integration.workspaceId} tenantWs=${tenant.workspaceId}`,
      );
      throw new ForbiddenException('workspace does not own tenant');
    }
    // Incident 2026-07-14 Phase 3a — validate caller-supplied workspaceId
    // against the resolved integration's workspaceId. Inline check first
    // (cheap, deterministic), then let the ProviderContextResolver run its
    // full hint-mismatch semantics for defense in depth + telemetry when it's
    // wired. Skipped entirely when the caller didn't supply the header —
    // preserves back-compat with Callio's pre-3a proxy calls.
    if (input.callerWorkspaceId) {
      if (integration.workspaceId !== input.callerWorkspaceId) {
        this.logger.warn(
          `[recording-proxy] scope_denied reason=caller_workspace_mismatch ` +
            `integrationId=${input.integrationId} ` +
            `integrationWs=${integration.workspaceId} ` +
            `callerWs=${input.callerWorkspaceId}`,
        );
        throw new ForbiddenException(
          'integrationId does not belong to caller workspace',
        );
      }
      if (this.providerContextResolver) {
        // Rule 4 fallthrough (workspace lookup) is fine here — the hint
        // check runs regardless of which rule fires. Any mismatch throws
        // 403 with `caller_hint_mismatch` telemetry. NotFound propagates
        // as the caller genuinely has no Twilio integration.
        await this.providerContextResolver.resolve({
          workspaceId: input.callerWorkspaceId,
          tenantId: input.tenantId,
          provider: ProviderType.TWILIO,
          integrationId: input.integrationId,
        });
      }
    }
    if (!integration.credentialsEncrypted) {
      throw new NotFoundException('integration has no stored credentials');
    }
    let creds: Partial<TwilioCreds>;
    try {
      creds = JSON.parse(
        this.encryptionService.decrypt(integration.credentialsEncrypted),
      ) as Partial<TwilioCreds>;
    } catch {
      // corrupt / mis-keyed row — surface as generic not-found so the caller
      // can't distinguish decrypt failure from missing row (info leak defense).
      throw new NotFoundException('integration credentials not readable');
    }
    if (!creds?.accountSid || !creds.authToken) {
      throw new NotFoundException('integration credentials incomplete');
    }
    if (creds.accountSid !== input.urlAccountSid) {
      this.logger.warn(
        `[recording-proxy] scope_denied reason=account_sid_mismatch ` +
          `integrationId=${input.integrationId} ` +
          `integrationAccount=${creds.accountSid} urlAccount=${input.urlAccountSid}`,
      );
      throw new ForbiddenException(
        'recording accountSid does not match integration',
      );
    }
    return { accountSid: creds.accountSid, authToken: creds.authToken };
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
