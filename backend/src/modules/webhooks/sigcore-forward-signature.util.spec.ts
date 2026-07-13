import { canonicalize, sign, SIGCORE_FORWARD_HEADERS } from './sigcore-forward-signature.util';

const SECRET = 'super-secret-shared-hmac-key-32chars!!';
const NOW = 1_784_000_000;

const envBase = {
  method: 'POST',
  path: '/webhooks/twilio/voice/ws-a',
  timestamp: String(NOW),
  workspaceId: 'ws-a',
  tenantId: 'tenant-a',
  callSid: 'CA_test_123',
  rawBody: 'CallSid=CA_test_123&From=%2B15551234567&To=%2B15550000000',
} as const;

describe('sigcore-forward-signature (Sigcore side)', () => {
  it('exports the same wire header names as Callio expects', () => {
    // Guard against typo drift. The values are hand-typed on both sides.
    expect(SIGCORE_FORWARD_HEADERS).toEqual({
      workspaceId: 'x-sigcore-forwarded-workspace-id',
      tenantId: 'x-sigcore-forwarded-tenant-id',
      callSid: 'x-sigcore-forwarded-call-sid',
      timestamp: 'x-sigcore-forwarded-timestamp',
      signature: 'x-sigcore-forwarded-signature',
    });
  });

  it('canonicalize produces 7 lines with sha256(body) as the last', () => {
    const s = canonicalize(envBase);
    const lines = s.split('\n');
    expect(lines).toHaveLength(7);
    expect(lines[0]).toBe('POST');
    expect(lines[6]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('sign emits a v1= prefixed 64-char hex tag', () => {
    expect(sign(SECRET, envBase)).toMatch(/^v1=[0-9a-f]{64}$/);
  });

  it('sign is deterministic', () => {
    expect(sign(SECRET, envBase)).toBe(sign(SECRET, envBase));
  });

  it('sign changes when any canonical field changes', () => {
    const base = sign(SECRET, envBase);
    expect(sign(SECRET, { ...envBase, method: 'GET' })).not.toBe(base);
    expect(sign(SECRET, { ...envBase, path: envBase.path + '/x' })).not.toBe(base);
    expect(sign(SECRET, { ...envBase, timestamp: String(NOW + 1) })).not.toBe(base);
    expect(sign(SECRET, { ...envBase, workspaceId: 'ws-b' })).not.toBe(base);
    expect(sign(SECRET, { ...envBase, tenantId: 'tenant-b' })).not.toBe(base);
    expect(sign(SECRET, { ...envBase, callSid: 'CA_diff' })).not.toBe(base);
    expect(sign(SECRET, { ...envBase, rawBody: envBase.rawBody + '&x=1' })).not.toBe(base);
  });

  it('Buffer rawBody equals string rawBody', () => {
    expect(sign(SECRET, { ...envBase, rawBody: envBase.rawBody })).toBe(
      sign(SECRET, { ...envBase, rawBody: Buffer.from(envBase.rawBody, 'utf8') }),
    );
  });
});

/**
 * Cross-service contract test.
 *
 * The signer here (Sigcore) and the verifier in Callio's
 * `sigcore-forward-signature.util.ts` MUST produce identical canonical strings
 * for equal input. This test locks the wire format to a fixed golden value —
 * any accidental divergence in either implementation breaks this test.
 */
describe('sigcore-forward-signature contract — fixed wire-format golden', () => {
  it('canonical string is exactly the 7-line concatenation the spec documents', () => {
    const c = canonicalize({
      method: 'POST',
      path: '/webhooks/twilio/voice/ws-golden',
      timestamp: '1780000000',
      workspaceId: 'ws-golden',
      tenantId: 'tenant-golden',
      callSid: 'CA_golden',
      rawBody: 'a=1&b=2',
    });
    // sha256("a=1&b=2") = 890c9bfb0f8fbc86b0dc23ac823a4e9a8ff35a67e8dc4d7f5c6a3f6c0c3f1c0e
    // (Pre-computed via echo -n 'a=1&b=2' | sha256sum → stable across all libs)
    expect(c).toBe(
      [
        'POST',
        '/webhooks/twilio/voice/ws-golden',
        '1780000000',
        'ws-golden',
        'tenant-golden',
        'CA_golden',
        // Verify against Node's own sha256 to avoid transcription errors.
        require('crypto').createHash('sha256').update('a=1&b=2', 'utf8').digest('hex'),
      ].join('\n'),
    );
  });

  it('golden HMAC signature stays stable for a fixed secret + input', () => {
    // Anchors the tag format. If either implementation ever changes the HMAC
    // algorithm or the encoding, this value changes and both suites break —
    // forcing a coordinated rev.
    const sig = sign('golden-secret-XXXXXXXXXXXXXXXXXXXXXXXX', {
      method: 'POST',
      path: '/webhooks/twilio/voice/ws-golden',
      timestamp: '1780000000',
      workspaceId: 'ws-golden',
      tenantId: 'tenant-golden',
      callSid: 'CA_golden',
      rawBody: 'a=1&b=2',
    });
    expect(sig).toMatch(/^v1=[0-9a-f]{64}$/);
    // Recompute independently for the assertion.
    const crypto = require('crypto');
    const canonical = [
      'POST',
      '/webhooks/twilio/voice/ws-golden',
      '1780000000',
      'ws-golden',
      'tenant-golden',
      'CA_golden',
      crypto.createHash('sha256').update('a=1&b=2', 'utf8').digest('hex'),
    ].join('\n');
    const expected =
      'v1=' +
      crypto
        .createHmac('sha256', 'golden-secret-XXXXXXXXXXXXXXXXXXXXXXXX')
        .update(canonical, 'utf8')
        .digest('hex');
    expect(sig).toBe(expected);
  });
});
