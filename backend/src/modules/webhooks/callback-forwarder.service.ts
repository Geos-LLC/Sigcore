import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosResponse, AxiosError } from 'axios';

import {
  ForwardEventType,
  SIGCORE_FORWARD_HEADERS,
  generateNonce,
  sign as signForwardEnvelope,
} from './sigcore-forward-signature.util';
import {
  CallbackTokenKind,
  CallbackTokenPayload,
  mintCallbackToken,
} from './sigcore-callback-token.util';

export interface ForwardCallbackInput {
  /**
   * The event type we forward to Callio. The Twilio-facing token's `kind`
   * and this eventType are locked together by the mint/verify path:
   *
   *   token.kind='recording_status' → eventType='voice_recording_status'
   *   token.kind='call_status'      → eventType='voice_call_status'
   */
  eventType: 'voice_recording_status' | 'voice_call_status';
  /** Destination URL on Callio (from the verified token payload). */
  callioDestUrl: string;
  /** Sigcore workspace + tenant that owns the call (from the token). */
  sigcoreWorkspaceId: string;
  sigcoreTenantId: string;
  /** Twilio's CallSid from the callback body. */
  providerCallSid: string;
  /** The verbatim body Twilio POSTed to Sigcore. */
  rawBody: Buffer;
  /** Content-Type from Twilio's callback. */
  contentType: string;
  /**
   * Twilio's original signature header, for downstream diagnostics only.
   * Callio does NOT validate against it in the forwarded path.
   */
  twilioSignature?: string;
}

export interface ForwardCallbackResult {
  outcome: 'success' | 'fallback';
  statusCode?: number;
  durationMs: number;
  reason?: string;
}

/**
 * Wave-2 Task 6B.5C — Twilio → Sigcore → Callio callback forwarder.
 *
 * Complements the Task 6B / PR 3 `TenantVoiceForwarderService` which
 * handles the inbound-voice TwiML path. This service handles the callback
 * direction — recording-status and call-status — using the same HMAC
 * envelope contract.
 *
 * Trust chain (mirrors inbound):
 *
 *   Twilio → Sigcore /webhooks/twilio/recording-status/:token
 *          (Sigcore verifies X-Twilio-Signature against the SUBACCOUNT auth
 *           token — the account that actually placed the call. This is the
 *           check Callio could not perform itself because Sigcore owns the
 *           subaccounts. Sigcore ALSO verifies the URL token to prevent
 *           attackers from firing arbitrary POSTs at Callio via Sigcore.)
 *          → HMAC-sign the outbound envelope with SIGCORE_VOICE_FORWARD_HMAC_SECRET
 *          → POST to the Callio URL embedded in the token
 *   Callio → verifies HMAC (same shared secret), pins eventType per route
 *
 * No callback ever reaches Callio unless Sigcore has already verified the
 * inbound Twilio signature AND the outbound URL token AND minted a fresh
 * HMAC envelope. Callio can trust the callback at face value.
 */
@Injectable()
export class CallbackForwarderService {
  private readonly logger = new Logger(CallbackForwarderService.name);
  private readonly hmacSecret: string | undefined;
  private readonly timeoutMs = 10_000;
  private readonly maxResponseBytes = 32 * 1024;

  constructor(configService: ConfigService) {
    this.hmacSecret = configService.get<string>(
      'SIGCORE_VOICE_FORWARD_HMAC_SECRET',
    );
  }

  /**
   * True when Sigcore's callback forwarding is armed (HMAC secret present).
   * When false, callback endpoints should fall back to no-forward behavior
   * (process into Sigcore's own tables) so a mis-provisioned env cannot
   * silently drop callbacks on the floor.
   */
  isArmed(): boolean {
    return Boolean(this.hmacSecret);
  }

  /**
   * POST the callback to Callio's URL under a signed HMAC envelope.
   * Non-2xx from Callio is classified as a fallback outcome — the caller
   * (Sigcore webhook controller) decides whether to also persist to
   * Sigcore's own tables as a backup.
   */
  async forward(input: ForwardCallbackInput): Promise<ForwardCallbackResult> {
    if (!this.hmacSecret) {
      return {
        outcome: 'fallback',
        durationMs: 0,
        reason: 'hmac_secret_not_configured',
      };
    }

    const path = this.extractSignedPath(input.callioDestUrl);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    // Phase B.1 — fresh nonce per forwarded callback.
    const nonce = generateNonce();
    const signature = signForwardEnvelope(this.hmacSecret, {
      method: 'POST',
      path,
      eventType: input.eventType,
      timestamp,
      nonce,
      workspaceId: input.sigcoreWorkspaceId,
      tenantId: input.sigcoreTenantId,
      callSid: input.providerCallSid,
      rawBody: input.rawBody,
    });

    const headers: Record<string, string> = {
      'content-type': input.contentType || 'application/x-www-form-urlencoded',
      'user-agent': 'Sigcore-Callback-Forwarder/1.0',
      [SIGCORE_FORWARD_HEADERS.workspaceId]: input.sigcoreWorkspaceId,
      [SIGCORE_FORWARD_HEADERS.tenantId]: input.sigcoreTenantId,
      [SIGCORE_FORWARD_HEADERS.callSid]: input.providerCallSid,
      [SIGCORE_FORWARD_HEADERS.timestamp]: timestamp,
      [SIGCORE_FORWARD_HEADERS.nonce]: nonce,
      [SIGCORE_FORWARD_HEADERS.eventType]: input.eventType,
      [SIGCORE_FORWARD_HEADERS.signature]: signature,
    };
    if (input.twilioSignature) {
      headers['x-twilio-signature'] = input.twilioSignature;
    }

    const started = Date.now();
    let response: AxiosResponse<unknown>;
    try {
      response = await axios.request({
        method: 'POST',
        url: input.callioDestUrl,
        data: input.rawBody,
        timeout: this.timeoutMs,
        maxRedirects: 0,
        maxContentLength: this.maxResponseBytes,
        validateStatus: (s) => s >= 200 && s < 300,
        responseType: 'text',
        transformResponse: (v) => v,
        headers,
      });
    } catch (err) {
      const durationMs = Date.now() - started;
      const ax = err as AxiosError;
      const statusCode = ax.response?.status;
      const reason = statusCode
        ? `response_${statusCode}`
        : ax.code || 'network_error';
      this.logger.warn(
        `sigcore_callback_forward_failed` +
          ` eventType=${input.eventType}` +
          ` sigcoreWorkspaceId=${input.sigcoreWorkspaceId}` +
          ` sigcoreTenantId=${input.sigcoreTenantId}` +
          ` providerCallSid=${input.providerCallSid}` +
          ` targetHost=${this.hostOf(input.callioDestUrl)}` +
          ` durationMs=${durationMs}` +
          ` statusCode=${statusCode ?? 'n/a'}` +
          ` reason=${reason}`,
      );
      return { outcome: 'fallback', durationMs, statusCode, reason };
    }
    const durationMs = Date.now() - started;
    this.logger.log(
      `sigcore_callback_forwarded` +
        ` eventType=${input.eventType}` +
        ` sigcoreWorkspaceId=${input.sigcoreWorkspaceId}` +
        ` sigcoreTenantId=${input.sigcoreTenantId}` +
        ` providerCallSid=${input.providerCallSid}` +
        ` targetHost=${this.hostOf(input.callioDestUrl)}` +
        ` durationMs=${durationMs}` +
        ` statusCode=${response.status}`,
    );
    return {
      outcome: 'success',
      statusCode: response.status,
      durationMs,
    };
  }

  /**
   * Task 6B.5C — token issuance helper. Used by Sigcore's operations
   * endpoints (recording_start, phone-number purchase) when constructing
   * the statusCallback URL that goes to Twilio. The token binds:
   *
   *   - the callback's product event kind (recording vs call status)
   *   - Sigcore workspace + tenant ownership (needed to attribute the
   *     callback back to a Callio identity after Twilio calls)
   *   - the Callio destination URL to forward to
   *   - optional Callio callId (recording-status only)
   *   - expiration (default: 24 hours)
   *
   * Callers assemble the full Twilio-facing URL as
   * `${sigcoreBaseUrl}/api/webhooks/twilio/${routeSegment}/${token}`.
   */
  mintToken(input: {
    kind: CallbackTokenKind;
    sigcoreWorkspaceId: string;
    sigcoreTenantId: string;
    callioDestUrl: string;
    callioCallId?: string;
    ttlSeconds?: number;
  }): string | null {
    if (!this.hmacSecret) return null;
    const now = Math.floor(Date.now() / 1000);
    const ttl = input.ttlSeconds ?? 86_400; // 24h default
    const payload: CallbackTokenPayload = {
      v: 1,
      kind: input.kind,
      sigcoreWorkspaceId: input.sigcoreWorkspaceId,
      sigcoreTenantId: input.sigcoreTenantId,
      callioDestUrl: input.callioDestUrl,
      callioCallId: input.callioCallId,
      exp: now + ttl,
    };
    return mintCallbackToken(this.hmacSecret, payload);
  }

  /**
   * Route helper: eventType per token kind. Kept as a public map so
   * controllers don't need to know the coupling detail.
   */
  eventTypeForKind(kind: CallbackTokenKind): ForwardEventType {
    return kind === 'recording_status'
      ? 'voice_recording_status'
      : 'voice_call_status';
  }

  private extractSignedPath(rawUrl: string): string {
    try {
      const u = new URL(rawUrl);
      return `${u.pathname}${u.search}`;
    } catch {
      return rawUrl;
    }
  }

  private hostOf(rawUrl: string): string {
    try {
      return new URL(rawUrl).host;
    } catch {
      return 'unknown';
    }
  }
}
