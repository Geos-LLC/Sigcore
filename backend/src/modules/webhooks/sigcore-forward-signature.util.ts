import * as crypto from 'crypto';

/**
 * Wave-2 authenticated Sigcore-forwarded inbound voice envelope.
 *
 * Trust chain:
 *   Twilio  →  Sigcore  (verifies X-Twilio-Signature against Twilio's number-owning account)
 *          →  Sigcore signs canonical(method, path, ts, ws, tenant, callSid, sha256(body)) with shared secret
 *          →  Callio (this verifier) accepts the request as Sigcore-authenticated
 *
 * When headers are present, this envelope is authoritative — Callio does NOT
 * fall back to Twilio signature checking. When headers are absent, callers
 * must still verify the original Twilio signature the pre-existing way.
 *
 * The wire format is deliberately conservative:
 *   - Signature prefix `v1=` reserves room for future rotations without a hard cutover.
 *   - Canonical string is a fixed 7-line, order-locked concatenation. No JSON
 *     canonicalization footguns, no header re-ordering ambiguity.
 *   - `sha256(rawBody)` covers the Twilio form body byte-for-byte, so Sigcore's
 *     PR-3 verbatim-relay contract is preserved without any per-field re-encoding.
 */

/**
 * Semantics of the forwarded headers:
 *
 *   x-sigcore-forwarded-workspace-id  — Sigcore's ORIGIN workspace (the
 *     workspace that owns the tenant/number on the Sigcore side). This is
 *     attribution context, authenticated by the HMAC signature — it is
 *     NOT the Callio destination workspace. Callio's destination workspace
 *     comes from the route path parameter and is bound to the signature
 *     via the canonical `<path>` line.
 *   x-sigcore-forwarded-tenant-id     — Sigcore's originating tenant id.
 *   x-sigcore-forwarded-call-sid      — Twilio's providerCallSid.
 *   x-sigcore-forwarded-timestamp     — Unix seconds when Sigcore signed.
 *   x-sigcore-forwarded-signature     — v1=<hex(hmac_sha256(secret, canon))>.
 *
 * A future rename may introduce `x-sigcore-origin-workspace-id` for clarity,
 * but we keep the current header name for now to avoid a cross-service rev.
 */
export const SIGCORE_FORWARD_HEADERS = {
  workspaceId: 'x-sigcore-forwarded-workspace-id',
  tenantId: 'x-sigcore-forwarded-tenant-id',
  callSid: 'x-sigcore-forwarded-call-sid',
  timestamp: 'x-sigcore-forwarded-timestamp',
  signature: 'x-sigcore-forwarded-signature',
  /**
   * Task 6B.5C — event-type discriminator. Bound to the signature, so a
   * valid `voice_inbound` envelope cannot be replayed against a
   * `voice_recording_status` route (or any other). Legal values:
   *
   *   voice_inbound          — Twilio inbound call → Callio TwiML endpoint
   *   voice_recording_status — Twilio recording-status callback
   *   voice_call_status      — Twilio call-status callback
   *
   * The route on Callio side reads this header and pins the expected
   * value before running verify(); a mismatched header + expected pair
   * fails BEFORE the signature is checked (see verify's `expectedEventType`).
   */
  eventType: 'x-sigcore-forwarded-event-type',
  /**
   * Phase B.1 — replay-protection nonce. Sigcore generates a fresh random
   * nonce per forwarded request; Callio stores it in Redis with TTL and
   * rejects duplicates within the freshness window (2× FRESHNESS_WINDOW_SECONDS
   * by default, i.e. 600s). Bound to the HMAC via the canonical string so a
   * request with a valid HMAC but missing/mutated nonce fails at
   * bad_signature (or missing_nonce).
   */
  nonce: 'x-sigcore-forwarded-nonce',
} as const;

/** Event types that Sigcore may forward. Route handlers pin one value each. */
export type ForwardEventType =
  | 'voice_inbound'
  | 'voice_recording_status'
  | 'voice_call_status';

/** Maximum clock skew tolerated between Sigcore and Callio, in seconds. */
export const FRESHNESS_WINDOW_SECONDS = 300;

/** Signature version prefix. `v1=` = HMAC-SHA256 over the canonical string. */
const SIGNATURE_PREFIX = 'v1=';

export type ForwardEnvelope = {
  method: string;
  path: string;
  /**
   * Task 6B.5C — event-type discriminator (see SIGCORE_FORWARD_HEADERS.eventType).
   */
  eventType: ForwardEventType;
  timestamp: string;
  /**
   * Phase B.1 — replay-protection nonce. Callers (Sigcore forwarders) MUST
   * populate this with a fresh unique value per request (recommended:
   * `crypto.randomUUID()` or `randomBytes(16).toString('hex')`). Verifiers
   * (Callio) treat empty string as "missing_nonce" and reject.
   */
  nonce: string;
  workspaceId: string;
  tenantId: string;
  callSid: string;
  rawBody: Buffer | string;
};

export type VerifyResult =
  | { ok: true; nonce: string }
  | {
      ok: false;
      // Machine-friendly reason. Never includes the secret or the raw signature.
      reason:
        | 'missing_signature'
        | 'missing_timestamp'
        | 'missing_workspace_id'
        | 'missing_tenant_id'
        | 'missing_call_sid'
        | 'missing_event_type'
        | 'missing_nonce'
        | 'malformed_nonce'
        | 'unexpected_event_type'
        | 'malformed_timestamp'
        | 'malformed_signature'
        | 'expired_timestamp'
        | 'bad_signature'
        | 'secret_not_configured';
    };

/**
 * Nonce format — 32 hex chars (16 random bytes). Verifiers enforce this
 * shape to prevent an attacker from smuggling arbitrary strings into the
 * Redis nonce store (unbounded key size, injection via key prefix, etc.).
 */
const NONCE_REGEX = /^[a-f0-9]{32}$/i;

/** Compute the canonical string that both sides sign. */
export function canonicalize(env: ForwardEnvelope): string {
  const body = typeof env.rawBody === 'string' ? env.rawBody : env.rawBody.toString('utf8');
  const bodyHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
  return [
    env.method.toUpperCase(),
    env.path,
    env.eventType,
    env.timestamp,
    env.nonce,
    env.workspaceId,
    env.tenantId,
    env.callSid,
    bodyHash,
  ].join('\n');
}

/**
 * Phase B.1 — generate a fresh cryptographically-random nonce for use as
 * `env.nonce`. 16 bytes → 32 hex chars → 128 bits of entropy. Every forward
 * gets a unique value; Callio rejects duplicates within the freshness window
 * via Redis.
 */
export function generateNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Produce the `v1=` signature over the canonical string. Sigcore uses this
 * when forwarding; Callio uses the same function when verifying.
 */
export function sign(secret: string, env: ForwardEnvelope): string {
  const canonical = canonicalize(env);
  const mac = crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
  return `${SIGNATURE_PREFIX}${mac}`;
}

/**
 * Verify an incoming Sigcore-forwarded envelope.
 *
 * Requires:
 *   - non-empty shared secret
 *   - all five forwarded headers present and non-empty
 *   - timestamp parses as integer seconds and is within FRESHNESS_WINDOW_SECONDS of `nowSeconds`
 *   - HMAC over the canonical string matches, using constant-time comparison
 *
 * NOTE — the forwarded `workspaceId` header is Sigcore's ORIGIN workspace,
 * not Callio's destination workspace. The Callio destination is the route
 * path parameter, which is bound to the signature via the `<path>` line
 * of the canonical string. A replay of a valid envelope against a different
 * Callio route therefore fails at `bad_signature` (the path in canonical
 * doesn't match the actually-hit path). This is asserted by a test.
 *
 * Returns a discriminated result so callers can log/emit a specific reason
 * without ever surfacing the secret or the received signature.
 */
export function verify(input: {
  secret: string | undefined;
  headers: {
    signature: string | undefined;
    timestamp: string | undefined;
    workspaceId: string | undefined;
    tenantId: string | undefined;
    callSid: string | undefined;
    /** Task 6B.5C — event-type header (see SIGCORE_FORWARD_HEADERS.eventType). */
    eventType: string | undefined;
    /** Phase B.1 — replay-protection nonce. */
    nonce: string | undefined;
  };
  /**
   * Task 6B.5C — the route's pinned event type. Every route pins ONE value
   * and passes it here; verify() rejects mismatches before checking the
   * signature. This is the last-line defense against an inbound-voice
   * envelope being replayed against a recording-status route.
   */
  expectedEventType: ForwardEventType;
  method: string;
  path: string;
  rawBody: Buffer | string;
  nowSeconds: number;
}): VerifyResult {
  const { secret, headers, expectedEventType } = input;
  if (!secret) return { ok: false, reason: 'secret_not_configured' };

  if (!headers.signature) return { ok: false, reason: 'missing_signature' };
  if (!headers.timestamp) return { ok: false, reason: 'missing_timestamp' };
  if (!headers.workspaceId) return { ok: false, reason: 'missing_workspace_id' };
  if (!headers.tenantId) return { ok: false, reason: 'missing_tenant_id' };
  if (!headers.callSid) return { ok: false, reason: 'missing_call_sid' };
  if (!headers.eventType) return { ok: false, reason: 'missing_event_type' };
  if (!headers.nonce) return { ok: false, reason: 'missing_nonce' };
  if (!NONCE_REGEX.test(headers.nonce)) {
    return { ok: false, reason: 'malformed_nonce' };
  }
  if (headers.eventType !== expectedEventType) {
    return { ok: false, reason: 'unexpected_event_type' };
  }

  if (!headers.signature.startsWith(SIGNATURE_PREFIX)) {
    return { ok: false, reason: 'malformed_signature' };
  }

  const ts = Number(headers.timestamp);
  if (!Number.isInteger(ts) || ts <= 0) {
    return { ok: false, reason: 'malformed_timestamp' };
  }
  if (Math.abs(input.nowSeconds - ts) > FRESHNESS_WINDOW_SECONDS) {
    return { ok: false, reason: 'expired_timestamp' };
  }

  const expected = sign(secret, {
    method: input.method,
    path: input.path,
    eventType: expectedEventType,
    timestamp: headers.timestamp,
    nonce: headers.nonce,
    workspaceId: headers.workspaceId,
    tenantId: headers.tenantId,
    callSid: headers.callSid,
    rawBody: input.rawBody,
  });

  const receivedBuf = Buffer.from(headers.signature, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (receivedBuf.length !== expectedBuf.length) {
    return { ok: false, reason: 'bad_signature' };
  }
  if (!crypto.timingSafeEqual(receivedBuf, expectedBuf)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true, nonce: headers.nonce };
}
