/**
 * Adversarial-auth pinned tests for Call-Scoped Capability (CSC) — G-6,
 * systemic-provisioning milestone, post-security-review 2026-08-22.
 *
 * TRUST MODEL:
 *   Sigcore = SOLE issuer (holds signing secret).
 *   Callio  = bearer (holds only opaque capability, no secret).
 *
 * The whole point of the redesign is that Callio (or anyone with access
 * to Callio's runtime env) CANNOT mint capabilities for calls Sigcore
 * hasn't already forwarded. The "Callio-cannot-mint" test block is the
 * most important assertion in this file.
 *
 * Also covered:
 *   - Forgery (bad sig, wrong secret, empty sig, random-bytes sig)
 *   - Payload tampering (allowedOps escalation, callSid swap)
 *   - Time bounds (expired, not_yet_valid, invalid_time_bounds)
 *   - Cross-call replay (capability for A used on B)
 *   - Cross-operation guard (op not in allowedOps)
 *   - Header malformation (missing, wrong parts, bad version)
 *   - Missing secret (fail closed)
 *
 * Integration-mismatch (capability.integrationId !== CommunicationCall.
 * metadata.integrationId) is enforced by IntegrationResourceGuard, NOT
 * this util — see integration-resource.guard.csap.spec.ts for that
 * check.
 */
import {
  mintCallCapability,
  verifyCallCapability,
  CSC_MAX_FUTURE_MS,
  CallScopedOperation,
} from './call-scoped-capability.util';

const SIGCORE_SECRET = 'sigcore-only-secret-32-bytes-!!!!!!!!';
const CALLIO_ATTACKER_SECRET = 'callio-runtime-guess-32-bytes-@@@@@@';
const CALL_SID = 'CA1234567890abcdef1234567890abcdef';
const OTHER_CALL_SID = 'CAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const INTEGRATION = 'a537cc3a-5c62-4f11-aff8-50fa840ef7a2';
const OTHER_INTEGRATION = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const NOW_MS = 1_800_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);
const DEFAULT_EXP_S = NOW_S + 4 * 3600; // 4 hours

function mint(overrides: {
  callSid?: string;
  integrationId?: string;
  allowedOps?: CallScopedOperation[];
  iat?: number;
  expUnixSeconds?: number;
  nonce?: string;
  secret?: string;
} = {}) {
  return mintCallCapability({
    callSid: overrides.callSid ?? CALL_SID,
    integrationId: overrides.integrationId ?? INTEGRATION,
    allowedOps: overrides.allowedOps ?? ['call.hangup', 'call.recording.start', 'call.recording.stop'],
    iat: overrides.iat ?? NOW_S,
    expUnixSeconds: overrides.expUnixSeconds ?? DEFAULT_EXP_S,
    nonce: overrides.nonce ?? 'AAAAAAAAAAAAAAAAAAAAAA',
    secret: overrides.secret ?? SIGCORE_SECRET,
  });
}

describe('CSC — happy path (Sigcore issues, Sigcore verifies)', () => {
  it('accepts a well-formed capability for an operation in allowedOps', () => {
    const cap = mint();
    const result = verifyCallCapability({
      headerValue: cap,
      secret: SIGCORE_SECRET,
      expectedOperation: 'call.hangup',
      expectedCallSid: CALL_SID,
      nowMs: NOW_MS,
    });
    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.payload.callSid).toBe(CALL_SID);
      expect(result.payload.integrationId).toBe(INTEGRATION);
      expect(result.payload.allowedOps).toEqual(
        expect.arrayContaining(['call.hangup', 'call.recording.start']),
      );
    }
  });

  it('accepts each allowedOp against its own endpoint', () => {
    const cap = mint({
      allowedOps: ['call.recording.start', 'call.recording.stop', 'call.hangup', 'call.transfer'],
    });
    for (const op of ['call.recording.start', 'call.recording.stop', 'call.hangup', 'call.transfer'] as CallScopedOperation[]) {
      const result = verifyCallCapability({
        headerValue: cap,
        secret: SIGCORE_SECRET,
        expectedOperation: op,
        expectedCallSid: CALL_SID,
        nowMs: NOW_MS,
      });
      expect(result.outcome).toBe('ok');
    }
  });

  it('accepts a capability at the exact edge of expiry', () => {
    const exp = NOW_S;
    const cap = mint({ iat: NOW_S - 10, expUnixSeconds: exp });
    const result = verifyCallCapability({
      headerValue: cap,
      secret: SIGCORE_SECRET,
      expectedOperation: 'call.hangup',
      expectedCallSid: CALL_SID,
      nowMs: NOW_MS,
    });
    expect(result.outcome).toBe('ok');
  });

  it('accepts a capability at the future edge of iat skew tolerance', () => {
    const iat = NOW_S + Math.floor(CSC_MAX_FUTURE_MS / 1000);
    const cap = mint({ iat, expUnixSeconds: iat + 3600 });
    const result = verifyCallCapability({
      headerValue: cap,
      secret: SIGCORE_SECRET,
      expectedOperation: 'call.hangup',
      expectedCallSid: CALL_SID,
      nowMs: NOW_MS,
    });
    expect(result.outcome).toBe('ok');
  });
});

// ────────────────────────────────────────────────────────────────────────
// THE CENTRAL SECURITY INVARIANT: Callio cannot mint.
//
// If Callio's runtime is compromised, the attacker has access to Callio's
// process env, source code, and any capabilities Sigcore has already
// forwarded for currently-live calls. What they do NOT have is Sigcore's
// signing secret. This block proves that the ABSENCE of the secret makes
// it computationally infeasible to construct a valid capability for any
// unrelated call.
// ────────────────────────────────────────────────────────────────────────
describe('CSC — Callio-cannot-mint (central security invariant)', () => {
  it('mintCallCapability throws when secret is empty (Callio has no secret)', () => {
    expect(() =>
      mintCallCapability({
        callSid: 'CA_ATTACKER_TARGET',
        integrationId: INTEGRATION,
        allowedOps: ['call.hangup'],
        expUnixSeconds: DEFAULT_EXP_S,
        secret: '',
      }),
    ).toThrow(/secret is required/);
  });

  it('attacker with any string except the true secret cannot forge a valid capability', () => {
    const attackerAttempts = [
      'a',
      'guessed-secret',
      'sigcore-only-secret-32-bytes-????????',
      SIGCORE_SECRET.slice(0, -1) + 'X',
      CALLIO_ATTACKER_SECRET,
    ];
    for (const attackerSecret of attackerAttempts) {
      const forged = mintCallCapability({
        callSid: 'CA_ATTACKER_TARGET',
        integrationId: INTEGRATION,
        allowedOps: ['call.hangup'],
        expUnixSeconds: DEFAULT_EXP_S,
        secret: attackerSecret,
      });
      const result = verifyCallCapability({
        headerValue: forged,
        secret: SIGCORE_SECRET,
        expectedOperation: 'call.hangup',
        expectedCallSid: 'CA_ATTACKER_TARGET',
        nowMs: NOW_MS,
      });
      expect(result).toEqual(expect.objectContaining({ outcome: 'fail', reason: 'bad_signature' }));
    }
  });

  it('attacker cannot re-mint an EXISTING capability to elevate allowedOps', () => {
    const attackerAttempt = mintCallCapability({
      callSid: CALL_SID,
      integrationId: INTEGRATION,
      allowedOps: ['call.hangup', 'call.recording.start'],
      expUnixSeconds: DEFAULT_EXP_S,
      secret: 'attacker-guess',
    });
    const result = verifyCallCapability({
      headerValue: attackerAttempt,
      secret: SIGCORE_SECRET,
      expectedOperation: 'call.recording.start',
      expectedCallSid: CALL_SID,
      nowMs: NOW_MS,
    });
    expect(result).toEqual(expect.objectContaining({ outcome: 'fail', reason: 'bad_signature' }));
  });

  it('attacker cannot extend expiry on a stolen legitimate capability', () => {
    const expired = mint({ iat: NOW_S - 10_000, expUnixSeconds: NOW_S - 5000 });
    const expiredResult = verifyCallCapability({
      headerValue: expired,
      secret: SIGCORE_SECRET,
      expectedOperation: 'call.hangup',
      expectedCallSid: CALL_SID,
      nowMs: NOW_MS,
    });
    expect(expiredResult).toEqual(expect.objectContaining({ outcome: 'fail', reason: 'expired' }));

    const attackerAttempt = mintCallCapability({
      callSid: CALL_SID,
      integrationId: INTEGRATION,
      allowedOps: ['call.hangup'],
      iat: NOW_S,
      expUnixSeconds: NOW_S + 3600,
      secret: 'attacker-guess',
    });
    const attackerResult = verifyCallCapability({
      headerValue: attackerAttempt,
      secret: SIGCORE_SECRET,
      expectedOperation: 'call.hangup',
      expectedCallSid: CALL_SID,
      nowMs: NOW_MS,
    });
    expect(attackerResult).toEqual(expect.objectContaining({ outcome: 'fail', reason: 'bad_signature' }));
  });

  it('attacker cannot mint a capability for a call/integration Sigcore never issued for', () => {
    const attackerAttempt = mintCallCapability({
      callSid: 'CA_SPOTLESS_CALL_ATTACKER_WANTS_TO_HANGUP',
      integrationId: OTHER_INTEGRATION,
      allowedOps: ['call.hangup'],
      expUnixSeconds: DEFAULT_EXP_S,
      secret: 'whatever-attacker-can-guess',
    });
    const result = verifyCallCapability({
      headerValue: attackerAttempt,
      secret: SIGCORE_SECRET,
      expectedOperation: 'call.hangup',
      expectedCallSid: 'CA_SPOTLESS_CALL_ATTACKER_WANTS_TO_HANGUP',
      nowMs: NOW_MS,
    });
    expect(result).toEqual(expect.objectContaining({ outcome: 'fail', reason: 'bad_signature' }));
  });
});

describe('CSC — forgery (structural)', () => {
  it('rejects a capability signed with the wrong secret', () => {
    const cap = mint({ secret: 'wrong-secret' });
    const result = verifyCallCapability({
      headerValue: cap,
      secret: SIGCORE_SECRET,
      expectedOperation: 'call.hangup',
      expectedCallSid: CALL_SID,
      nowMs: NOW_MS,
    });
    expect(result).toEqual(expect.objectContaining({ outcome: 'fail', reason: 'bad_signature' }));
  });

  it('rejects a capability with a tampered payload byte (integration swap)', () => {
    const good = mint();
    const goodSig = good.split('.')[2];
    const tamperedPayload = mint({ integrationId: OTHER_INTEGRATION }).split('.')[1];
    const forged = `v1.${tamperedPayload}.${goodSig}`;
    const result = verifyCallCapability({
      headerValue: forged,
      secret: SIGCORE_SECRET,
      expectedOperation: 'call.hangup',
      expectedCallSid: CALL_SID,
      nowMs: NOW_MS,
    });
    expect(result).toEqual(expect.objectContaining({ outcome: 'fail', reason: 'bad_signature' }));
  });

  it('rejects a random-bytes signature of the correct length', () => {
    const cap = mint();
    const parts = cap.split('.');
    const bogusSig = 'X'.repeat(43);
    const forged = `${parts[0]}.${parts[1]}.${bogusSig}`;
    const result = verifyCallCapability({
      headerValue: forged,
      secret: SIGCORE_SECRET,
      expectedOperation: 'call.hangup',
      expectedCallSid: CALL_SID,
      nowMs: NOW_MS,
    });
    expect(result).toEqual(expect.objectContaining({ outcome: 'fail', reason: 'bad_signature' }));
  });
});

describe('CSC — expiry', () => {
  it('rejects an expired capability', () => {
    const cap = mint({ iat: NOW_S - 10_000, expUnixSeconds: NOW_S - 1 });
    const result = verifyCallCapability({
      headerValue: cap,
      secret: SIGCORE_SECRET,
      expectedOperation: 'call.hangup',
      expectedCallSid: CALL_SID,
      nowMs: NOW_MS,
    });
    expect(result).toEqual(expect.objectContaining({ outcome: 'fail', reason: 'expired' }));
  });

  it('rejects a not-yet-valid capability (iat far in future)', () => {
    const iat = NOW_S + Math.floor(CSC_MAX_FUTURE_MS / 1000) + 10;
    const cap = mint({ iat, expUnixSeconds: iat + 3600 });
    const result = verifyCallCapability({
      headerValue: cap,
      secret: SIGCORE_SECRET,
      expectedOperation: 'call.hangup',
      expectedCallSid: CALL_SID,
      nowMs: NOW_MS,
    });
    expect(result).toEqual(expect.objectContaining({ outcome: 'fail', reason: 'not_yet_valid' }));
  });

  it('rejects invalid time bounds (exp <= iat) via mint-time check', () => {
    expect(() =>
      mintCallCapability({
        callSid: CALL_SID,
        integrationId: INTEGRATION,
        allowedOps: ['call.hangup'],
        iat: NOW_S,
        expUnixSeconds: NOW_S,
        secret: SIGCORE_SECRET,
      }),
    ).toThrow(/expUnixSeconds must be strictly greater than iat/);
  });
});

describe('CSC — cross-call replay', () => {
  it('rejects a capability for call A used against call B', () => {
    const capForA = mint({ callSid: CALL_SID });
    const result = verifyCallCapability({
      headerValue: capForA,
      secret: SIGCORE_SECRET,
      expectedOperation: 'call.hangup',
      expectedCallSid: OTHER_CALL_SID,
      nowMs: NOW_MS,
    });
    expect(result).toEqual(expect.objectContaining({ outcome: 'fail', reason: 'call_mismatch' }));
  });
});

describe('CSC — cross-operation (allowedOps enforcement)', () => {
  it('rejects when endpoint requires an op not listed in capability.allowedOps', () => {
    const hangupOnly = mint({ allowedOps: ['call.hangup'] });
    const result = verifyCallCapability({
      headerValue: hangupOnly,
      secret: SIGCORE_SECRET,
      expectedOperation: 'call.recording.start',
      expectedCallSid: CALL_SID,
      nowMs: NOW_MS,
    });
    expect(result).toEqual(expect.objectContaining({ outcome: 'fail', reason: 'operation_not_allowed' }));
  });

  it('rejects even adjacent operations not explicitly allowed', () => {
    const startOnly = mint({ allowedOps: ['call.recording.start'] });
    const result = verifyCallCapability({
      headerValue: startOnly,
      secret: SIGCORE_SECRET,
      expectedOperation: 'call.recording.stop',
      expectedCallSid: CALL_SID,
      nowMs: NOW_MS,
    });
    expect(result).toEqual(expect.objectContaining({ outcome: 'fail', reason: 'operation_not_allowed' }));
  });

  it('rejects transfer when Sigcore did not include it in allowedOps', () => {
    const notTransfer = mint({
      allowedOps: ['call.hangup', 'call.recording.start', 'call.recording.stop'],
    });
    const result = verifyCallCapability({
      headerValue: notTransfer,
      secret: SIGCORE_SECRET,
      expectedOperation: 'call.transfer',
      expectedCallSid: CALL_SID,
      nowMs: NOW_MS,
    });
    expect(result).toEqual(expect.objectContaining({ outcome: 'fail', reason: 'operation_not_allowed' }));
  });
});

describe('CSC — header malformation', () => {
  it('rejects null / empty / non-string header', () => {
    for (const bad of [null, undefined, '', 42 as any, {} as any]) {
      const result = verifyCallCapability({
        headerValue: bad,
        secret: SIGCORE_SECRET,
        expectedOperation: 'call.hangup',
        expectedCallSid: CALL_SID,
        nowMs: NOW_MS,
      });
      expect(result.outcome).toBe('fail');
      if (result.outcome === 'fail') expect(result.reason).toBe('missing_header');
    }
  });

  it('rejects a header with wrong part count', () => {
    for (const bad of ['v1.abc', 'v1.abc.def.ghi', 'no-dots-at-all']) {
      const result = verifyCallCapability({
        headerValue: bad,
        secret: SIGCORE_SECRET,
        expectedOperation: 'call.hangup',
        expectedCallSid: CALL_SID,
        nowMs: NOW_MS,
      });
      expect(result.outcome).toBe('fail');
      if (result.outcome === 'fail') {
        expect(['malformed_header', 'missing_header']).toContain(result.reason);
      }
    }
  });

  it('rejects a v2 payload against a v1 verifier (future-compat clamp)', () => {
    const cap = mint();
    const parts = cap.split('.');
    const withV2 = `v2.${parts[1]}.${parts[2]}`;
    const result = verifyCallCapability({
      headerValue: withV2,
      secret: SIGCORE_SECRET,
      expectedOperation: 'call.hangup',
      expectedCallSid: CALL_SID,
      nowMs: NOW_MS,
    });
    expect(result).toEqual(expect.objectContaining({ outcome: 'fail', reason: 'unsupported_version' }));
  });
});

describe('CSC — missing secret (fail closed)', () => {
  it('verifier fails closed when Sigcore secret is not configured (null)', () => {
    const cap = mint();
    const result = verifyCallCapability({
      headerValue: cap,
      secret: null,
      expectedOperation: 'call.hangup',
      expectedCallSid: CALL_SID,
      nowMs: NOW_MS,
    });
    expect(result).toEqual(expect.objectContaining({ outcome: 'fail', reason: 'missing_secret' }));
  });

  it('verifier fails closed when Sigcore secret is empty string', () => {
    const cap = mint();
    const result = verifyCallCapability({
      headerValue: cap,
      secret: '',
      expectedOperation: 'call.hangup',
      expectedCallSid: CALL_SID,
      nowMs: NOW_MS,
    });
    expect(result).toEqual(expect.objectContaining({ outcome: 'fail', reason: 'missing_secret' }));
  });

  it('mint fast-fails when allowedOps is empty', () => {
    expect(() =>
      mintCallCapability({
        callSid: CALL_SID,
        integrationId: INTEGRATION,
        allowedOps: [],
        expUnixSeconds: DEFAULT_EXP_S,
        secret: SIGCORE_SECRET,
      }),
    ).toThrow(/allowedOps/);
  });
});

describe('CSC — determinism / nonce', () => {
  it('two mints back-to-back produce different capabilities (nonce uniqueness)', () => {
    const a = mintCallCapability({
      callSid: CALL_SID,
      integrationId: INTEGRATION,
      allowedOps: ['call.hangup'],
      expUnixSeconds: DEFAULT_EXP_S,
      secret: SIGCORE_SECRET,
    });
    const b = mintCallCapability({
      callSid: CALL_SID,
      integrationId: INTEGRATION,
      allowedOps: ['call.hangup'],
      expUnixSeconds: DEFAULT_EXP_S,
      secret: SIGCORE_SECRET,
    });
    expect(a).not.toBe(b);
  });

  it('mint with a fixed nonce + iat is deterministic (signature-stability check)', () => {
    const a = mint({ nonce: 'FIXEDNONCEFIXEDNONCEFI' });
    const b = mint({ nonce: 'FIXEDNONCEFIXEDNONCEFI' });
    expect(a).toBe(b);
  });
});
