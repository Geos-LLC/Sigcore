import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, AxiosResponse } from 'axios';
import { EmailService } from '../email/email.service';
import {
  SIGCORE_FORWARD_HEADERS,
  generateNonce,
  sign as signForwardEnvelope,
} from './sigcore-forward-signature.util';

/**
 * Correlation fields injected into every log line so failed forwards can be
 * traced back to a specific inbound Twilio call. Never contains credentials
 * or Twilio body content.
 */
export interface ForwardCorrelation {
  workspaceId: string;
  tenantId: string;
  providerCallSid: string;
  environment: string;
}

export interface ForwardInput {
  voiceInboundUrl: string;
  /** Verbatim Twilio request body — raw bytes if available, otherwise
   *  URL-encoded form data re-serialized from the parsed payload. */
  rawBody: Buffer | string;
  /** application/x-www-form-urlencoded (Twilio default) or whatever the
   *  original request carried. */
  contentType: string;
  /** Twilio signature header — forwarded verbatim so downstream can verify
   *  against the original webhook URL if needed. */
  twilioSignature: string | undefined;
  /** All x-forwarded-* headers from the inbound request. */
  forwardedHeaders: Record<string, string>;
  /** For log correlation and alerting. */
  correlation: ForwardCorrelation;
}

/**
 * A `success` result carries the TwiML body returned by the tenant. The
 * caller must return it byte-for-byte to Twilio. `statusCode` is only used
 * for logging.
 *
 * A `fallback` result carries the classification reason. The caller MUST
 * fall through to voicemail — no retries, no second forwarding attempt.
 */
export type ForwardResult =
  | {
      outcome: 'success';
      twiml: string;
      statusCode: number;
      durationMs: number;
      contentType: string | undefined;
    }
  | {
      outcome: 'fallback';
      reason: ForwardFailureReason;
      category: 'definite' | 'ambiguous';
      durationMs: number;
      statusCode?: number;
    };

export type ForwardFailureReason =
  | 'timeout'
  | 'dns'
  | 'tls'
  | 'network_reset'
  | 'connection_refused'
  | 'response_400'
  | 'response_401'
  | 'response_403'
  | 'response_404'
  | 'response_5xx'
  | 'response_other'
  | 'empty_response'
  | 'malformed_xml'
  | 'oversized_response'
  | 'not_twiml_root';

/**
 * Wave-2 Voice Foundation Phase 1 (PR 3) — transparent inbound voice
 * forwarder.
 *
 * Sigcore acts as a proxy: takes the Twilio inbound POST body verbatim,
 * hands it to the tenant's `voice_inbound_url`, waits for a TwiML response
 * (5s), and returns that response byte-for-byte to Twilio. Never generates
 * TwiML if the tenant forward succeeds.
 *
 * Failure policy (Georgi's PR 3 spec):
 *   - Definite: HTTP 400 / 401 / 403 / 404 → immediate fallback
 *   - Ambiguous: timeout / DNS / TLS / 5xx / network reset → immediate fallback
 *   - NO retries under any condition (single attempt)
 *
 * Feature flag: `SIGCORE_VOICE_INBOUND_FORWARD_ENABLED`. When false (default),
 * the caller must skip this service entirely so runtime behaviour is
 * byte-identical to pre-PR-3.
 */
@Injectable()
export class TenantVoiceForwarderService {
  private readonly logger = new Logger(TenantVoiceForwarderService.name);
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly alertEmail: string | undefined;
  private readonly forwardHmacSecret: string | undefined;

  constructor(
    private readonly configService: ConfigService,
    private readonly emailService: EmailService,
  ) {
    const configuredTimeout = Number(
      this.configService.get<string>('VOICE_FORWARD_TIMEOUT_MS'),
    );
    this.timeoutMs =
      Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : 5000;
    const configuredMax = Number(
      this.configService.get<string>('VOICE_FORWARD_MAX_RESPONSE_BYTES'),
    );
    this.maxResponseBytes =
      Number.isFinite(configuredMax) && configuredMax > 0
        ? configuredMax
        : 65536;
    this.alertEmail =
      this.configService.get<string>('VOICE_FORWARD_ALERT_EMAIL') || undefined;
    // Wave-2 B.5 — HMAC shared secret used to sign the forwarded envelope.
    // When unset, forwarded requests carry only the diagnostic correlation
    // headers (no signature). Receivers such as Callio Wave-2 will reject
    // unsigned forwards. This is intentional: a rollout that intends to
    // forward to Callio must set the secret first.
    this.forwardHmacSecret =
      this.configService.get<string>('SIGCORE_VOICE_FORWARD_HMAC_SECRET') || undefined;
    if (!this.forwardHmacSecret) {
      this.logger.warn(
        'SIGCORE_VOICE_FORWARD_HMAC_SECRET not set — forwarded envelopes will NOT include x-sigcore-forwarded-signature. Set this before pointing any tenant voiceInboundUrl at an authenticated receiver (Callio Wave-2).',
      );
    }
  }

  /**
   * Single-attempt forward. Never throws — every failure path returns a
   * classified `fallback` result so the caller can flow to voicemail
   * without special-case handling.
   *
   * Emits one structured log line per call (success or fallback). On
   * fallback, fires a best-effort email alert (fire-and-forget; never
   * blocks the returned promise).
   */
  async forward(input: ForwardInput): Promise<ForwardResult> {
    const startedAt = Date.now();
    let response: AxiosResponse<unknown>;
    try {
      response = await axios.request<unknown>({
        method: 'POST',
        url: input.voiceInboundUrl,
        data: input.rawBody,
        timeout: this.timeoutMs,
        maxRedirects: 0,
        maxContentLength: this.maxResponseBytes,
        // Reject anything non-2xx as an error so we can classify it in the
        // catch block. Keeps success handling clean.
        validateStatus: (s) => s >= 200 && s < 300,
        responseType: 'text',
        transformResponse: (v) => v,
        headers: this.buildForwardHeaders(input),
      });
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const classified = this.classifyAxiosError(err);
      this.logForwardOutcome({
        outcome: 'fallback',
        reason: classified.reason,
        category: classified.category,
        durationMs,
        statusCode: classified.statusCode,
        correlation: input.correlation,
        voiceInboundUrl: input.voiceInboundUrl,
      });
      this.fireAlert({
        input,
        reason: classified.reason,
        category: classified.category,
        durationMs,
        statusCode: classified.statusCode,
      });
      return {
        outcome: 'fallback',
        reason: classified.reason,
        category: classified.category,
        durationMs,
        statusCode: classified.statusCode,
      };
    }

    // Success-code path — still validate the response body shape before
    // trusting it as TwiML.
    const durationMs = Date.now() - startedAt;
    const bodyStr = typeof response.data === 'string' ? response.data : '';
    const shapeError = this.validateTwimlShape(bodyStr);
    if (shapeError) {
      this.logForwardOutcome({
        outcome: 'fallback',
        reason: shapeError,
        category: 'ambiguous',
        durationMs,
        statusCode: response.status,
        correlation: input.correlation,
        voiceInboundUrl: input.voiceInboundUrl,
      });
      this.fireAlert({
        input,
        reason: shapeError,
        category: 'ambiguous',
        durationMs,
        statusCode: response.status,
      });
      return {
        outcome: 'fallback',
        reason: shapeError,
        category: 'ambiguous',
        durationMs,
        statusCode: response.status,
      };
    }

    this.logForwardOutcome({
      outcome: 'success',
      durationMs,
      statusCode: response.status,
      correlation: input.correlation,
      voiceInboundUrl: input.voiceInboundUrl,
    });

    const respContentType =
      typeof response.headers === 'object' &&
      response.headers !== null &&
      typeof (response.headers as Record<string, unknown>)['content-type'] ===
        'string'
        ? ((response.headers as Record<string, string>)['content-type'])
        : undefined;

    return {
      outcome: 'success',
      twiml: bodyStr,
      statusCode: response.status,
      durationMs,
      contentType: respContentType,
    };
  }

  private buildForwardHeaders(input: ForwardInput): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': input.contentType,
      // Twilio identifies its proxy via this UA — we present a distinct one
      // so downstream can attribute the forwarded request to Sigcore.
      'user-agent': 'Sigcore-Voice-Forwarder/1.0',
      // Correlation headers so the tenant can attribute the request to a
      // Sigcore workspace + tenant + call without parsing the body.
      [SIGCORE_FORWARD_HEADERS.workspaceId]: input.correlation.workspaceId,
      [SIGCORE_FORWARD_HEADERS.tenantId]: input.correlation.tenantId,
      [SIGCORE_FORWARD_HEADERS.callSid]: input.correlation.providerCallSid,
    };
    if (input.twilioSignature) {
      // Kept for diagnostics + downstream correlation. Callio Wave-2 does NOT
      // validate against it — it validates the HMAC envelope below.
      headers['x-twilio-signature'] = input.twilioSignature;
    }
    for (const [k, v] of Object.entries(input.forwardedHeaders)) {
      // Only pass through x-forwarded-* per PR 3 spec — never leak arbitrary
      // headers from the incoming request.
      if (k.toLowerCase().startsWith('x-forwarded-')) {
        headers[k.toLowerCase()] = v;
      }
    }
    // Wave-2 B.5 — sign the envelope so an authenticated receiver (Callio)
    // can trust this hop without needing to re-verify Twilio's signature
    // against Sigcore's URL/token. Path is `pathname + search` of the
    // configured voiceInboundUrl; Callio uses `req.originalUrl` for the
    // same value.
    if (this.forwardHmacSecret) {
      const timestamp = Math.floor(Date.now() / 1000).toString();
      // Phase B.1 — fresh nonce per forward for Callio replay protection.
      const nonce = generateNonce();
      const path = this.extractSignedPath(input.voiceInboundUrl);
      headers[SIGCORE_FORWARD_HEADERS.timestamp] = timestamp;
      headers[SIGCORE_FORWARD_HEADERS.nonce] = nonce;
      // Task 6B.5C — pin eventType so a valid inbound-voice envelope cannot
      // be replayed against a callback route on Callio.
      headers[SIGCORE_FORWARD_HEADERS.eventType] = 'voice_inbound';
      headers[SIGCORE_FORWARD_HEADERS.signature] = signForwardEnvelope(
        this.forwardHmacSecret,
        {
          method: 'POST',
          path,
          eventType: 'voice_inbound',
          timestamp,
          nonce,
          workspaceId: input.correlation.workspaceId,
          tenantId: input.correlation.tenantId,
          callSid: input.correlation.providerCallSid,
          rawBody: input.rawBody,
        },
      );
    }
    return headers;
  }

  private extractSignedPath(rawUrl: string): string {
    try {
      const u = new URL(rawUrl);
      return `${u.pathname}${u.search}`;
    } catch {
      // If the URL is unparseable the forwarder will fail immediately at
      // axios level; return the raw value so any signed path we do produce
      // still deterministically matches what Callio would see.
      return rawUrl;
    }
  }

  private validateTwimlShape(body: string): ForwardFailureReason | null {
    if (!body || body.trim().length === 0) {
      return 'empty_response';
    }
    if (Buffer.byteLength(body, 'utf8') > this.maxResponseBytes) {
      return 'oversized_response';
    }
    // Cheap syntactic guard — Twilio expects `<Response>...</Response>` as
    // the root element. Anything else means the tenant returned HTML, JSON,
    // or garbage. We do NOT parse XML — the caller streams the response
    // to Twilio verbatim on success.
    const trimmed = body.trimStart();
    if (!/^<\?xml[\s\S]*?<Response\b/i.test(trimmed) && !/^<Response\b/i.test(trimmed)) {
      return 'not_twiml_root';
    }
    // Very light well-formedness check — the response must contain a matching
    // closing tag. A malformed body without it fails.
    if (!/<\/Response>\s*$/i.test(body.trimEnd())) {
      return 'malformed_xml';
    }
    return null;
  }

  private classifyAxiosError(err: unknown): {
    reason: ForwardFailureReason;
    category: 'definite' | 'ambiguous';
    statusCode?: number;
  } {
    // Duck-type: `axios.isAxiosError()` returns false for errors that lack
    // the axios prototype (as commonly synthesized in unit tests). We only
    // need `.code` and `.response.status` to classify, so check for those
    // directly rather than the prototype.
    const looksAxiosLike =
      typeof err === 'object' &&
      err !== null &&
      ('isAxiosError' in err ||
        'code' in err ||
        (err as { response?: unknown }).response !== undefined);
    if (looksAxiosLike) {
      const axErr = err as AxiosError;
      const code = axErr.code;
      // Response-body size exceeded `maxContentLength`. Axios aborts the
      // download and rejects with `ERR_BAD_RESPONSE` + a message string
      // containing "maxContentLength" — stable across axios 0.x and 1.x.
      // Detect explicitly so the classifier reports `oversized_response`
      // rather than falling through to the ambiguous `network_reset`
      // default. The `validateTwimlShape` size guard is unreachable in
      // production because axios rejects before the body is buffered;
      // this branch is what makes `oversized_response` observable.
      if (
        typeof axErr.message === 'string' &&
        /maxContentLength/i.test(axErr.message)
      ) {
        return { reason: 'oversized_response', category: 'ambiguous' };
      }
      if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
        return { reason: 'timeout', category: 'ambiguous' };
      }
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        return { reason: 'dns', category: 'ambiguous' };
      }
      if (code === 'ECONNREFUSED') {
        return { reason: 'connection_refused', category: 'ambiguous' };
      }
      if (code === 'ECONNRESET' || code === 'EPIPE') {
        return { reason: 'network_reset', category: 'ambiguous' };
      }
      if (
        code === 'CERT_HAS_EXPIRED' ||
        code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
        code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
        code === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
        code === 'SELF_SIGNED_CERT_IN_CHAIN'
      ) {
        return { reason: 'tls', category: 'ambiguous' };
      }
      if (axErr.response) {
        const status = axErr.response.status;
        if (status === 400) return { reason: 'response_400', category: 'definite', statusCode: 400 };
        if (status === 401) return { reason: 'response_401', category: 'definite', statusCode: 401 };
        if (status === 403) return { reason: 'response_403', category: 'definite', statusCode: 403 };
        if (status === 404) return { reason: 'response_404', category: 'definite', statusCode: 404 };
        if (status >= 500 && status < 600) {
          return { reason: 'response_5xx', category: 'ambiguous', statusCode: status };
        }
        return { reason: 'response_other', category: 'ambiguous', statusCode: status };
      }
    }
    return { reason: 'network_reset', category: 'ambiguous' };
  }

  private logForwardOutcome(input: {
    outcome: 'success' | 'fallback';
    reason?: ForwardFailureReason;
    category?: 'definite' | 'ambiguous';
    durationMs: number;
    statusCode?: number;
    correlation: ForwardCorrelation;
    voiceInboundUrl: string;
  }): void {
    const targetHost = (() => {
      try {
        return new URL(input.voiceInboundUrl).host;
      } catch {
        return 'invalid-url';
      }
    })();
    const kv: Array<[string, string | number | undefined]> = [
      ['voice_inbound_path', 'tenant_forward'],
      ['env', input.correlation.environment],
      ['workspaceId', input.correlation.workspaceId],
      ['tenantId', input.correlation.tenantId],
      ['providerCallSid', input.correlation.providerCallSid],
      ['targetHost', targetHost],
      ['durationMs', input.durationMs],
      ['outcome', input.outcome],
      ['statusCode', input.statusCode],
      ['reason', input.reason],
      ['category', input.category],
    ];
    const line = kv
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    if (input.outcome === 'success') {
      this.logger.log(line);
    } else {
      this.logger.warn(line);
    }
  }

  private fireAlert(input: {
    input: ForwardInput;
    reason: ForwardFailureReason;
    category: 'definite' | 'ambiguous';
    durationMs: number;
    statusCode?: number;
  }): void {
    // Fire-and-forget. Never blocks the caller's TwiML response. Never
    // throws into voice runtime — the EmailService itself already returns
    // false on unconfigured / errored delivery.
    void this.emailService
      .sendVoiceForwardFailureAlert({
        to: this.alertEmail,
        environment: input.input.correlation.environment,
        workspaceId: input.input.correlation.workspaceId,
        tenantId: input.input.correlation.tenantId,
        providerCallSid: input.input.correlation.providerCallSid,
        voiceInboundUrl: input.input.voiceInboundUrl,
        reason: input.reason,
        category: input.category,
        durationMs: input.durationMs,
        statusCode: input.statusCode,
      })
      .catch((err) => {
        this.logger.error(
          `sendVoiceForwardFailureAlert failed: ${(err as Error).message}`,
        );
      });
  }
}
