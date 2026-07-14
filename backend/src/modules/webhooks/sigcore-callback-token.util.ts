import * as crypto from 'crypto';

/**
 * Wave-2 Task 6B.5C — stateless callback token.
 *
 * When Callio asks Sigcore to start a recording (or when Sigcore configures
 * a phone number's status callback), Sigcore needs Twilio to fire the
 * callback back to a Sigcore URL — so Sigcore can verify Twilio's signature
 * against the subaccount's auth token, then HMAC-sign the forwarded body
 * for Callio. But Sigcore also needs to know:
 *
 *   - which Callio URL to forward the callback to
 *   - which Sigcore (workspace, tenant) owns the call
 *   - which product event this callback belongs to (recording vs status)
 *
 * Rather than adding a database table indexed by callback ID, we encode
 * all of this in a signed opaque token embedded in the Twilio-facing URL.
 * The token is HMAC-signed with the same `SIGCORE_VOICE_FORWARD_HMAC_SECRET`
 * that Callio uses to verify forwarded envelopes, so Sigcore does not need
 * a second secret to manage.
 *
 * Wire format:
 *
 *   <base64url(json(payload))>.<hex(hmac_sha256(secret, that_base64url))>
 *
 * Design invariants:
 *
 *   1. Stateless — no DB row, no cache. The token contains everything
 *      Sigcore needs to forward the callback.
 *
 *   2. Bounded by expiration — every token carries an `exp` timestamp; the
 *      verifier rejects expired tokens. Twilio's callbacks land within
 *      seconds/minutes of the outbound API call, so a 24h horizon is
 *      generous.
 *
 *   3. HMAC bound to `kind` — a token minted for recording-status can NOT
 *      be verified by the call-status endpoint (each endpoint pins its
 *      expected `kind`). This is the Task 6B.5C event-type replay defense
 *      applied at the Twilio→Sigcore hop, mirroring the Callio-side
 *      `expectedEventType` check on the Sigcore→Callio hop.
 *
 *   4. No secrets in the payload — the token embeds destination URL and
 *      Sigcore-internal IDs, all of which are already visible to both
 *      services. The token IS the proof that Sigcore minted this URL;
 *      possession + HMAC verify is enough.
 */

/**
 * Phase C.2 (2026-07-14) — `media_session` kind added.
 *
 * A media_session token binds an outbound-answer TwiML redirect + Callio
 * WSS connection to a specific (workspace, tenant, integration, callioCallId,
 * providerCallSid). Sigcore mints when answerMode='media_stream' at dial
 * time. Twilio embeds the token in two hops:
 *
 *   1. Answer URL:  https://sigcore.../outbound-answer/<token>
 *      → Sigcore verifies (kind='media_session'), returns TwiML
 *        <Connect><Stream url="wss://callio.../voice-stream?session=<token>"/></Connect>
 *
 *   2. WSS URL:     wss://callio.../voice-stream?session=<token>
 *      → Callio verifies (kind='media_session'), enforces single-use via
 *        Redis (SETNX), bootstraps orchestrator against the bound callioCallId.
 *
 * Same wire format as recording/call-status tokens (`<b64>.<hex>`), same
 * HMAC secret (`SIGCORE_VOICE_FORWARD_HMAC_SECRET`) — Callio only needs
 * to know one thing to verify all three token classes.
 */
export type CallbackTokenKind = 'recording_status' | 'call_status' | 'media_session';

export interface CallbackTokenPayload {
  /** Format version — bump for backward-incompatible payload changes. */
  v: 1;
  /** Event kind — recording vs call status vs media session. Bound to the token HMAC. */
  kind: CallbackTokenKind;
  /** Sigcore's workspace + tenant. Forwarded to Callio in the HMAC envelope. */
  sigcoreWorkspaceId: string;
  sigcoreTenantId: string;
  /**
   * The Callio URL Sigcore will POST the HMAC-signed callback to. For
   * `media_session` this is the wss:// URL Callio will accept a media
   * stream on (Sigcore validates it's ws:// or wss://).
   */
  callioDestUrl: string;
  /**
   * Callio's internal callId — only present for recording-status where
   * Callio wants to correlate the recording back to its own row. Absent
   * for call-status where the callback's `CallSid` is the correlation.
   *
   * Phase C.2 — REQUIRED for `media_session`: Callio uses it to look up
   * the voice_calls row for the outbound call before bootstrapping the
   * orchestrator.
   */
  callioCallId?: string;
  /**
   * Phase C.2 — media_session only. The Twilio providerCallSid bound to
   * this token; Callio verifies the WSS payload's `start` event carries
   * the same CallSid before touching the orchestrator (defense against
   * token reuse across calls).
   */
  providerCallSid?: string;
  /**
   * Phase C.2 — media_session only. The Sigcore integration id that
   * placed the call. Callio uses it to attribute the outbound leg to
   * the right integration for hangup + recording ops (which already go
   * through Sigcore per Phase A).
   */
  integrationId?: string;
  /** Unix seconds when this token stops being accepted. */
  exp: number;
}

/**
 * Mint a signed token that Twilio will echo back in the callback URL.
 * Returned as `<b64>.<mac>`; embed in a URL path segment.
 */
export function mintCallbackToken(
  secret: string,
  payload: CallbackTokenPayload,
): string {
  const json = JSON.stringify(payload);
  const b64 = Buffer.from(json, 'utf8').toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(b64, 'utf8').digest('hex');
  return `${b64}.${mac}`;
}

export type VerifyTokenResult =
  | { ok: true; payload: CallbackTokenPayload }
  | {
      ok: false;
      // Machine-friendly reason; never surface the received token or secret in logs.
      reason:
        | 'secret_not_configured'
        | 'malformed_token'
        | 'malformed_payload'
        | 'bad_signature'
        | 'expired'
        | 'wrong_kind';
    };

/**
 * Verify a callback token from a Twilio-facing URL path segment. Callers
 * pin `expectedKind` to their route (recording-status route pins
 * 'recording_status'; call-status pins 'call_status').
 */
export function verifyCallbackToken(input: {
  secret: string | undefined;
  token: string | undefined;
  expectedKind: CallbackTokenKind;
  nowSeconds: number;
}): VerifyTokenResult {
  if (!input.secret) return { ok: false, reason: 'secret_not_configured' };
  if (!input.token) return { ok: false, reason: 'malformed_token' };
  const parts = input.token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: 'malformed_token' };
  }
  const [b64, receivedMac] = parts;
  const expectedMac = crypto
    .createHmac('sha256', input.secret)
    .update(b64, 'utf8')
    .digest('hex');
  const recvBuf = Buffer.from(receivedMac, 'utf8');
  const expBuf = Buffer.from(expectedMac, 'utf8');
  if (
    recvBuf.length !== expBuf.length ||
    !crypto.timingSafeEqual(recvBuf, expBuf)
  ) {
    return { ok: false, reason: 'bad_signature' };
  }
  let payload: CallbackTokenPayload;
  try {
    payload = JSON.parse(
      Buffer.from(b64, 'base64url').toString('utf8'),
    ) as CallbackTokenPayload;
  } catch {
    return { ok: false, reason: 'malformed_payload' };
  }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    payload.v !== 1 ||
    typeof payload.kind !== 'string' ||
    typeof payload.sigcoreWorkspaceId !== 'string' ||
    typeof payload.sigcoreTenantId !== 'string' ||
    typeof payload.callioDestUrl !== 'string' ||
    typeof payload.exp !== 'number'
  ) {
    return { ok: false, reason: 'malformed_payload' };
  }
  if (payload.exp < input.nowSeconds) {
    return { ok: false, reason: 'expired' };
  }
  if (payload.kind !== input.expectedKind) {
    return { ok: false, reason: 'wrong_kind' };
  }
  return { ok: true, payload };
}
