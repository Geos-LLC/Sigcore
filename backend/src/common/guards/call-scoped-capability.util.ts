import { createHmac, timingSafeEqual, randomBytes } from 'crypto';

/**
 * Call-Scoped Capability (CSC) — G-6, systemic-provisioning milestone
 * (2026-08-22).
 *
 * TRUST MODEL (post-security-review 2026-08-22):
 *
 *   Sigcore is the SOLE issuer of call capabilities. Callio is a bearer,
 *   never a minter. The signing secret (SIGCORE_CALL_CAPABILITY_SECRET)
 *   lives on Sigcore ONLY — never on Callio, never in a shared vault
 *   accessible to Callio's runtime.
 *
 *   During inbound-call forwarding, Sigcore mints an opaque capability
 *   binding a specific (callSid, integrationId, allowedOps, exp) and
 *   injects it in the forwarded envelope headers. Callio stores the
 *   capability on the VoiceCall row (metadata.sigcoreCallCapability)
 *   and echoes it as X-Sigcore-Call-Capability on admin operations
 *   (recording/start, hangup, transfer). Sigcore verifies + authorizes.
 *
 *   The threat model deliberately assumes Callio COULD be compromised.
 *   In that scenario the attacker gains authority to execute capabilities
 *   already issued for calls Sigcore has already forwarded — bounded by
 *   (allowedOps, exp) per capability. The attacker CANNOT mint
 *   capabilities for unrelated calls, other integrations, other
 *   operations, or extend expiry.
 *
 * Previous design (rejected in security review): symmetric HMAC secret
 * shared between Callio and Sigcore, with Callio minting proofs itself.
 * That model concentrated authority in Callio — a compromised Callio
 * could mint proofs for ANY call/integration/operation. Sigcore-issuance
 * removes that blast radius.
 *
 * HEADER FORMAT (Sigcore -> Callio inbound envelope AND Callio -> Sigcore
 * admin echo -- same header, same value, verified only by Sigcore):
 *
 *   X-Sigcore-Call-Capability: v1.<base64url(payload-json)>.<base64url(sig)>
 *
 * PAYLOAD SHAPE (canonical JSON -- key order is FIXED for deterministic
 * signing; do NOT change key order across releases without a version bump):
 *
 *   {
 *     "v": 1,
 *     "callSid": "CA<hex>",
 *     "integrationId": "<uuid>",
 *     "allowedOps": ["call.hangup", "call.recording.start", ...],
 *     "iat": <unix-seconds>,      // issued at
 *     "exp": <unix-seconds>,      // hard expiry -- Sigcore-decided
 *     "nonce": "<b64url 16 bytes>"
 *   }
 *
 * SIGNATURE: HMAC-SHA256(sigcore_secret, canonical_payload_utf8_bytes).
 *
 * FRESHNESS: `iat` and `exp` are ABSOLUTE unix timestamps, both minted
 * by Sigcore. Callio cannot extend either. Verification requires
 * `iat <= now <= exp` (with `CSC_MAX_FUTURE_MS` clock-skew tolerance on
 * `iat`).
 *
 * ANTI-REPLAY: within [iat, exp] window a valid capability MAY be replayed.
 * Both `call.hangup` and `call.recording.start` are idempotent at Twilio
 * (hangup on ended call = no-op; recording-start on already-recording call
 * returns existing recording). Redis-backed nonce dedup is deliberately
 * out of scope (per milestone directive). If a compromised Callio replays,
 * the impact is bounded to a Sigcore/Twilio no-op or already-in-state
 * response.
 *
 * ADVERSARIAL GUARANTEES (each has a pinned test):
 *   1. Forgery: any signature that doesn't equal HMAC(secret, payload) is
 *      rejected with `bad_signature`. Uses constant-time compare.
 *   2. Callio-cannot-mint: a party without SIGCORE_CALL_CAPABILITY_SECRET
 *      cannot construct a signature Sigcore will accept. Enforced by the
 *      HMAC contract itself — pinned by the "no secret -> cannot forge"
 *      test that simulates Callio's runtime attempting to mint.
 *   3. Payload tampering: any byte modified after signing -> HMAC fail.
 *   4. Expiry: `now > exp` -> `expired`; `now < iat - skew` -> `not_yet_valid`.
 *   5. Cross-call replay: capability for call A used on URL for call B
 *      -> `call_mismatch`.
 *   6. Cross-operation replay: capability with `allowedOps=['call.hangup']`
 *      used on `/recording/start` -> `operation_not_allowed`.
 *   7. Integration mismatch: capability's `integrationId` !== the
 *      CommunicationCall's stamped `metadata.integrationId` -- enforced by
 *      the guard's DB-lookup step, NOT this util. This util only proves
 *      the capability itself is authentic and semantically-scoped.
 *
 * BOUNDARY WITH IntegrationResourceGuard: this util is a pure
 * verification helper. It reads the header + secret + expected op + call
 * SID and returns a discriminated result. It does NOT touch the DB. The
 * guard performs the final "integrationId matches the actual call row"
 * check because that requires DB access.
 */

// Freshness windows.
// - Capabilities expire per Sigcore's `exp` claim (Sigcore-decided; the
//   default at mint time is ~4 hours to cover a long call + post-call tail).
// - `iat` clock-skew tolerance protects against Sigcore/Callio drift.
export const CSC_MAX_FUTURE_MS = 30 * 1000; // 30s -- clock-skew tolerance on iat

export const CSC_HEADER_NAME = 'x-sigcore-call-capability';

export type CallScopedOperation =
  | 'call.recording.start'
  | 'call.recording.stop'
  | 'call.hangup'
  | 'call.transfer';

export interface CallScopedCapabilityPayload {
  v: 1;
  callSid: string;
  integrationId: string;
  allowedOps: CallScopedOperation[];
  iat: number; // unix seconds
  exp: number; // unix seconds
  nonce: string; // base64url 16 random bytes
}

export type CallScopedCapabilityFailReason =
  | 'missing_header'
  | 'malformed_header'
  | 'malformed_payload'
  | 'unsupported_version'
  | 'bad_signature'
  | 'expired'
  | 'not_yet_valid'
  | 'invalid_time_bounds'
  | 'operation_not_allowed'
  | 'call_mismatch'
  | 'missing_secret'
  | 'internal_error';

export type CallScopedCapabilityResult =
  | { outcome: 'ok'; payload: CallScopedCapabilityPayload }
  | { outcome: 'fail'; reason: CallScopedCapabilityFailReason; detail?: string };

// ── SIGCORE-ONLY: mint ────────────────────────────────────────────────────
//
// This function MUST NOT be shipped inside the Callio backend. Sigcore's
// TenantVoiceForwarderService (and any future Sigcore-side issuer) is the
// sole allowed caller. See the trust-model docs at the top of this file.

export interface MintCapabilityInput {
  callSid: string;
  integrationId: string;
  allowedOps: CallScopedOperation[];
  secret: string;
  /** Absolute expiry — unix seconds. Sigcore issuer chooses. */
  expUnixSeconds: number;
  /** Issued-at override for tests. Runtime uses Date.now(). */
  iat?: number;
  /** Nonce override for tests. Runtime generates one. */
  nonce?: string;
}

export function mintCallCapability(input: MintCapabilityInput): string {
  if (!input.secret) {
    throw new Error('mintCallCapability: secret is required (Sigcore-only)');
  }
  if (!Array.isArray(input.allowedOps) || input.allowedOps.length === 0) {
    throw new Error('mintCallCapability: allowedOps must be a non-empty array');
  }
  const iat = input.iat ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(input.expUnixSeconds) || input.expUnixSeconds <= iat) {
    throw new Error('mintCallCapability: expUnixSeconds must be strictly greater than iat');
  }
  const payload: CallScopedCapabilityPayload = {
    v: 1,
    callSid: input.callSid,
    integrationId: input.integrationId,
    allowedOps: [...input.allowedOps], // defensive copy — caller mutation shouldn't affect signed bytes
    iat,
    exp: input.expUnixSeconds,
    nonce: input.nonce ?? base64url(randomBytes(16)),
  };
  const payloadBytes = Buffer.from(canonicalize(payload), 'utf8');
  const sig = createHmac('sha256', input.secret).update(payloadBytes).digest();
  return `v1.${base64url(payloadBytes)}.${base64url(sig)}`;
}

// ── SIGCORE-ONLY: verify ──────────────────────────────────────────────────
//
// Sigcore calls this in IntegrationResourceGuard to authorize an incoming
// admin request. Callio never verifies — Callio only echoes the opaque
// header value.

export interface VerifyCapabilityInput {
  headerValue: string | null | undefined;
  secret: string | null | undefined;
  /** The operation the endpoint represents (from decorator metadata). */
  expectedOperation: CallScopedOperation;
  /** The callSid from the URL param (must match the capability). */
  expectedCallSid: string;
  /** UNIX ms — freshness anchor. Defaults to Date.now(). */
  nowMs?: number;
  /** Clock-skew tolerance on iat. Overridable for tests. */
  maxFutureMs?: number;
}

export function verifyCallCapability(input: VerifyCapabilityInput): CallScopedCapabilityResult {
  const nowMs = input.nowMs ?? Date.now();
  const maxFutureMs = input.maxFutureMs ?? CSC_MAX_FUTURE_MS;

  if (!input.secret) {
    return { outcome: 'fail', reason: 'missing_secret' };
  }
  if (!input.headerValue || typeof input.headerValue !== 'string') {
    return { outcome: 'fail', reason: 'missing_header' };
  }
  const parts = input.headerValue.split('.');
  if (parts.length !== 3) {
    return { outcome: 'fail', reason: 'malformed_header', detail: `expected 3 parts, got ${parts.length}` };
  }
  const [versionTag, payloadB64, sigB64] = parts;
  if (versionTag !== 'v1') {
    return { outcome: 'fail', reason: 'unsupported_version', detail: `got '${versionTag}'` };
  }

  let payloadBytes: Buffer;
  let sig: Buffer;
  try {
    payloadBytes = fromBase64url(payloadB64);
    sig = fromBase64url(sigB64);
  } catch (err) {
    return { outcome: 'fail', reason: 'malformed_header', detail: (err as Error).message };
  }

  // Constant-time signature verify BEFORE parsing payload — do not leak
  // timing info about the payload contents to a forgery attacker.
  const expected = createHmac('sha256', input.secret).update(payloadBytes).digest();
  if (expected.length !== sig.length || !timingSafeEqual(expected, sig)) {
    return { outcome: 'fail', reason: 'bad_signature' };
  }

  let payload: CallScopedCapabilityPayload;
  try {
    const parsed = JSON.parse(payloadBytes.toString('utf8'));
    if (!isValidPayloadShape(parsed)) {
      return { outcome: 'fail', reason: 'malformed_payload' };
    }
    payload = parsed;
  } catch (err) {
    return { outcome: 'fail', reason: 'malformed_payload', detail: (err as Error).message };
  }

  if (payload.v !== 1) {
    return { outcome: 'fail', reason: 'unsupported_version', detail: `payload.v=${payload.v}` };
  }

  // Cross-call replay guard.
  if (payload.callSid !== input.expectedCallSid) {
    return { outcome: 'fail', reason: 'call_mismatch' };
  }

  // Cross-operation guard — capability MUST list the endpoint's operation.
  if (!payload.allowedOps.includes(input.expectedOperation)) {
    return {
      outcome: 'fail',
      reason: 'operation_not_allowed',
      detail: `endpoint requires '${input.expectedOperation}', capability allows [${payload.allowedOps.join(', ')}]`,
    };
  }

  // Time bounds sanity.
  if (payload.exp <= payload.iat) {
    return { outcome: 'fail', reason: 'invalid_time_bounds' };
  }
  const iatMs = payload.iat * 1000;
  const expMs = payload.exp * 1000;
  if (nowMs > expMs) {
    return { outcome: 'fail', reason: 'expired', detail: `nowMs=${nowMs} expMs=${expMs}` };
  }
  if (nowMs + maxFutureMs < iatMs) {
    return {
      outcome: 'fail',
      reason: 'not_yet_valid',
      detail: `nowMs=${nowMs} iatMs=${iatMs} skewMs=${maxFutureMs}`,
    };
  }

  return { outcome: 'ok', payload };
}

// ── helpers ─────────────────────────────────────────────────────────────

/**
 * Canonical JSON — key order is FIXED so signatures are deterministic.
 * `allowedOps` is emitted verbatim (caller-supplied order preserved).
 */
function canonicalize(p: CallScopedCapabilityPayload): string {
  return JSON.stringify({
    v: p.v,
    callSid: p.callSid,
    integrationId: p.integrationId,
    allowedOps: p.allowedOps,
    iat: p.iat,
    exp: p.exp,
    nonce: p.nonce,
  });
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function isValidPayloadShape(x: unknown): x is CallScopedCapabilityPayload {
  if (!x || typeof x !== 'object') return false;
  const p = x as Record<string, unknown>;
  return (
    p.v === 1 &&
    typeof p.callSid === 'string' &&
    p.callSid.length > 0 &&
    typeof p.integrationId === 'string' &&
    p.integrationId.length > 0 &&
    Array.isArray(p.allowedOps) &&
    p.allowedOps.length > 0 &&
    p.allowedOps.every((op) => typeof op === 'string' && op.length > 0) &&
    typeof p.iat === 'number' &&
    Number.isFinite(p.iat) &&
    typeof p.exp === 'number' &&
    Number.isFinite(p.exp) &&
    typeof p.nonce === 'string' &&
    p.nonce.length > 0
  );
}
