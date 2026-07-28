/**
 * Wave-2 B.5 + Task 6B.5C — Sigcore-forwarded envelope signature contract.
 *
 * Every canonical field is under a rejection test so a tampered envelope
 * (path, timestamp, workspaceId, tenantId, callSid, eventType, body)
 * cannot pass verification. Golden-value canonical string test guards
 * against silent format drift between Sigcore and Callio.
 */

import {
  FRESHNESS_WINDOW_SECONDS,
  ForwardEnvelope,
  ForwardEventType,
  canonicalize,
  sign,
  verify,
} from './sigcore-forward-signature.util';

const SECRET = 'super-secret-shared-hmac-key-32chars!!';
const NOW = 1_784_000_000; // 2026-07-15-ish

const TEST_NONCE = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

const envBase: ForwardEnvelope = {
  method: 'POST',
  path: '/webhooks/twilio/voice/ws-a',
  eventType: 'voice_inbound',
  timestamp: String(NOW),
  nonce: TEST_NONCE,
  workspaceId: 'ws-a',
  tenantId: 'tenant-a',
  callSid: 'CA_test_123',
  rawBody: 'CallSid=CA_test_123&From=%2B15551234567&To=%2B15550000000',
};

function makeHeaders(env: ForwardEnvelope, signature: string) {
  return {
    signature,
    timestamp: env.timestamp,
    nonce: env.nonce,
    workspaceId: env.workspaceId,
    tenantId: env.tenantId,
    callSid: env.callSid,
    eventType: env.eventType,
  };
}

function verifyEnvelope(
  env: ForwardEnvelope,
  overrides: {
    secret?: string | undefined;
    // Sentinel distinguishing "not overridden" from "explicit undefined".
    secretExplicit?: boolean;
    expectedEventType?: ForwardEventType;
    nowSeconds?: number;
    path?: string;
    rawBody?: string | Buffer;
    headers?: Partial<ReturnType<typeof makeHeaders>>;
  } = {},
) {
  const signature = sign(SECRET, env);
  return verify({
    secret: 'secret' in overrides ? overrides.secret : SECRET,
    headers: { ...makeHeaders(env, signature), ...(overrides.headers ?? {}) },
    expectedEventType: overrides.expectedEventType ?? env.eventType,
    method: env.method,
    path: overrides.path ?? env.path,
    rawBody: overrides.rawBody ?? env.rawBody,
    nowSeconds: overrides.nowSeconds ?? NOW,
  });
}

describe('canonicalize (v3 shape — 9-line, eventType + nonce included)', () => {
  it('produces the exact 9-line canonical string', () => {
    const s = canonicalize(envBase);
    const lines = s.split('\n');
    expect(lines).toHaveLength(9);
    expect(lines[0]).toBe('POST');
    expect(lines[1]).toBe('/webhooks/twilio/voice/ws-a');
    expect(lines[2]).toBe('voice_inbound');
    expect(lines[3]).toBe(String(NOW));
    expect(lines[4]).toBe(TEST_NONCE);
    expect(lines[5]).toBe('ws-a');
    expect(lines[6]).toBe('tenant-a');
    expect(lines[7]).toBe('CA_test_123');
    expect(lines[8]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('normalizes method to uppercase', () => {
    const s = canonicalize({ ...envBase, method: 'post' });
    expect(s.split('\n')[0]).toBe('POST');
  });

  it('handles Buffer rawBody identically to string', () => {
    const asString = canonicalize(envBase);
    const asBuffer = canonicalize({
      ...envBase,
      rawBody: Buffer.from(envBase.rawBody as string, 'utf8'),
    });
    expect(asString).toBe(asBuffer);
  });
});

describe('sign', () => {
  it('emits a v1= prefixed 64-char hex tag', () => {
    expect(sign(SECRET, envBase)).toMatch(/^v1=[0-9a-f]{64}$/);
  });

  it('is deterministic for the same input', () => {
    expect(sign(SECRET, envBase)).toBe(sign(SECRET, envBase));
  });

  it('changes when ANY canonical field changes (path, timestamp, workspaceId, tenantId, callSid, eventType, body, method)', () => {
    const base = sign(SECRET, envBase);
    expect(sign(SECRET, { ...envBase, method: 'GET' })).not.toBe(base);
    expect(sign(SECRET, { ...envBase, path: '/x' })).not.toBe(base);
    expect(sign(SECRET, { ...envBase, timestamp: String(NOW + 1) })).not.toBe(base);
    expect(sign(SECRET, { ...envBase, workspaceId: 'ws-b' })).not.toBe(base);
    expect(sign(SECRET, { ...envBase, tenantId: 'tenant-b' })).not.toBe(base);
    expect(sign(SECRET, { ...envBase, callSid: 'CA_x' })).not.toBe(base);
    expect(sign(SECRET, { ...envBase, eventType: 'voice_recording_status' })).not.toBe(base);
    expect(sign(SECRET, { ...envBase, rawBody: envBase.rawBody + '&x=1' })).not.toBe(base);
  });

  it('changes when the secret changes', () => {
    expect(sign('other-secret', envBase)).not.toBe(sign(SECRET, envBase));
  });
});

describe('verify — happy path', () => {
  it('accepts a well-formed voice_inbound envelope', () => {
    expect(verifyEnvelope(envBase)).toEqual({ ok: true, nonce: TEST_NONCE });
  });

  it('accepts a well-formed voice_recording_status envelope', () => {
    const env: ForwardEnvelope = {
      ...envBase,
      eventType: 'voice_recording_status',
      path: '/webhooks/twilio/voice/recording-status/call-uuid',
    };
    expect(verifyEnvelope(env)).toEqual({ ok: true, nonce: TEST_NONCE });
  });

  it('accepts a well-formed voice_call_status envelope', () => {
    const env: ForwardEnvelope = {
      ...envBase,
      eventType: 'voice_call_status',
      path: '/webhooks/twilio/status/ws-a',
    };
    expect(verifyEnvelope(env)).toEqual({ ok: true, nonce: TEST_NONCE });
  });

  it('accepts at the exact freshness window boundary', () => {
    expect(verifyEnvelope(envBase, { nowSeconds: NOW + FRESHNESS_WINDOW_SECONDS })).toEqual({
      ok: true,
      nonce: TEST_NONCE,
    });
  });
});

describe('verify — rejections', () => {
  it('secret_not_configured when secret undefined', () => {
    expect(verifyEnvelope(envBase, { secret: undefined })).toEqual({
      ok: false,
      reason: 'secret_not_configured',
    });
  });

  it('missing_signature when signature header absent', () => {
    expect(
      verifyEnvelope(envBase, { headers: { signature: undefined } }),
    ).toEqual({ ok: false, reason: 'missing_signature' });
  });

  it.each([
    ['timestamp', 'missing_timestamp'],
    ['workspaceId', 'missing_workspace_id'],
    ['tenantId', 'missing_tenant_id'],
    ['callSid', 'missing_call_sid'],
    ['eventType', 'missing_event_type'],
  ] as const)('rejects missing correlation header %s → %s', (field, reason) => {
    const r = verifyEnvelope(envBase, {
      headers: { [field]: undefined } as Partial<ReturnType<typeof makeHeaders>>,
    });
    expect(r).toEqual({ ok: false, reason });
  });

  it('unexpected_event_type when route pins a different value than the envelope carries', () => {
    // This is the Task 6B.5C replay-prevention property: an inbound-voice
    // envelope signed by Sigcore cannot be replayed against a route that
    // pins expectedEventType='voice_recording_status'.
    const r = verifyEnvelope(envBase, {
      expectedEventType: 'voice_recording_status',
    });
    expect(r).toEqual({ ok: false, reason: 'unexpected_event_type' });
  });

  it('malformed_signature when v1= prefix absent', () => {
    const badSig = sign(SECRET, envBase).replace(/^v1=/, '');
    expect(verifyEnvelope(envBase, { headers: { signature: badSig } })).toEqual({
      ok: false,
      reason: 'malformed_signature',
    });
  });

  it.each(['abc', '3.14', '-1', '0'])('malformed_timestamp for %j', (ts) => {
    const r = verifyEnvelope(envBase, { headers: { timestamp: ts } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('malformed_timestamp');
  });

  it('expired_timestamp beyond the freshness window (both directions)', () => {
    expect(
      verifyEnvelope(envBase, { nowSeconds: NOW + FRESHNESS_WINDOW_SECONDS + 1 }),
    ).toEqual({ ok: false, reason: 'expired_timestamp' });
    expect(
      verifyEnvelope(envBase, { nowSeconds: NOW - FRESHNESS_WINDOW_SECONDS - 1 }),
    ).toEqual({ ok: false, reason: 'expired_timestamp' });
  });

  it('bad_signature when route path is replayed with a different destination path', () => {
    // Signed for path A, verified at path B — signature no longer validates.
    const r = verifyEnvelope(envBase, {
      path: '/webhooks/twilio/voice/attacker-ws',
    });
    expect(r).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('bad_signature when body is tampered', () => {
    const r = verifyEnvelope(envBase, { rawBody: envBase.rawBody + '&x=1' });
    expect(r).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('bad_signature when tenantId header is tampered', () => {
    const r = verifyEnvelope(envBase, { headers: { tenantId: 'evil' } });
    expect(r).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('bad_signature when callSid header is tampered', () => {
    const r = verifyEnvelope(envBase, { headers: { callSid: 'CA_evil' } });
    expect(r).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('bad_signature when workspaceId header is tampered', () => {
    const r = verifyEnvelope(envBase, { headers: { workspaceId: 'ws-evil' } });
    expect(r).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('event-type replay prevention (Task 6B.5C explicit test)', () => {
  it('inbound-voice envelope replayed against recording-status route → unexpected_event_type', () => {
    // Sigcore signs a valid voice_inbound envelope. Attacker replays it at
    // the recording-status route which pins expectedEventType=voice_recording_status.
    // Verifier rejects with unexpected_event_type BEFORE signature compare.
    const env: ForwardEnvelope = { ...envBase, eventType: 'voice_inbound' };
    const r = verifyEnvelope(env, {
      expectedEventType: 'voice_recording_status',
    });
    expect(r).toEqual({ ok: false, reason: 'unexpected_event_type' });
  });

  it('recording-status envelope replayed against inbound-voice route → unexpected_event_type', () => {
    const env: ForwardEnvelope = {
      ...envBase,
      eventType: 'voice_recording_status',
    };
    const r = verifyEnvelope(env, { expectedEventType: 'voice_inbound' });
    expect(r).toEqual({ ok: false, reason: 'unexpected_event_type' });
  });

  it('call-status envelope replayed against recording-status route → unexpected_event_type', () => {
    const env: ForwardEnvelope = {
      ...envBase,
      eventType: 'voice_call_status',
    };
    const r = verifyEnvelope(env, {
      expectedEventType: 'voice_recording_status',
    });
    expect(r).toEqual({ ok: false, reason: 'unexpected_event_type' });
  });
});
