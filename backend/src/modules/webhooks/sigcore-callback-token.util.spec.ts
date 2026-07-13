import {
  mintCallbackToken,
  verifyCallbackToken,
  CallbackTokenPayload,
} from './sigcore-callback-token.util';

const SECRET = 'test-secret-for-callback-tokens';
const OTHER_SECRET = 'a-different-secret';

const NOW = 1_700_000_000;
const FUTURE = NOW + 3600;

function payload(over: Partial<CallbackTokenPayload> = {}): CallbackTokenPayload {
  return {
    v: 1,
    kind: 'recording_status',
    sigcoreWorkspaceId: 'ws_abc',
    sigcoreTenantId: 'tn_xyz',
    callioDestUrl: 'https://callio.example/api/webhooks/twilio/recording-status/call_123',
    callioCallId: 'call_123',
    exp: FUTURE,
    ...over,
  };
}

describe('sigcore-callback-token.util', () => {
  describe('mintCallbackToken', () => {
    it('produces a deterministic <b64>.<mac> token for identical inputs', () => {
      const a = mintCallbackToken(SECRET, payload());
      const b = mintCallbackToken(SECRET, payload());
      expect(a).toBe(b);
      const parts = a.split('.');
      expect(parts).toHaveLength(2);
      expect(parts[0].length).toBeGreaterThan(0);
      expect(parts[1]).toMatch(/^[0-9a-f]{64}$/);
    });

    it('produces different signatures under different secrets', () => {
      const a = mintCallbackToken(SECRET, payload());
      const b = mintCallbackToken(OTHER_SECRET, payload());
      expect(a).not.toBe(b);
      expect(a.split('.')[0]).toBe(b.split('.')[0]); // same b64 payload
      expect(a.split('.')[1]).not.toBe(b.split('.')[1]); // different mac
    });
  });

  describe('verifyCallbackToken', () => {
    it('accepts a freshly minted matching-kind token', () => {
      const token = mintCallbackToken(SECRET, payload());
      const result = verifyCallbackToken({
        secret: SECRET,
        token,
        expectedKind: 'recording_status',
        nowSeconds: NOW,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.sigcoreWorkspaceId).toBe('ws_abc');
        expect(result.payload.sigcoreTenantId).toBe('tn_xyz');
        expect(result.payload.callioCallId).toBe('call_123');
      }
    });

    it('rejects when secret is not configured', () => {
      const token = mintCallbackToken(SECRET, payload());
      const result = verifyCallbackToken({
        secret: undefined,
        token,
        expectedKind: 'recording_status',
        nowSeconds: NOW,
      });
      expect(result).toEqual({ ok: false, reason: 'secret_not_configured' });
    });

    it('rejects a malformed token missing the dot separator', () => {
      const result = verifyCallbackToken({
        secret: SECRET,
        token: 'no-dot-here',
        expectedKind: 'recording_status',
        nowSeconds: NOW,
      });
      expect(result).toEqual({ ok: false, reason: 'malformed_token' });
    });

    it('rejects an empty token', () => {
      const result = verifyCallbackToken({
        secret: SECRET,
        token: '',
        expectedKind: 'recording_status',
        nowSeconds: NOW,
      });
      expect(result).toEqual({ ok: false, reason: 'malformed_token' });
    });

    it('rejects when signed with the wrong secret', () => {
      const token = mintCallbackToken(OTHER_SECRET, payload());
      const result = verifyCallbackToken({
        secret: SECRET,
        token,
        expectedKind: 'recording_status',
        nowSeconds: NOW,
      });
      expect(result).toEqual({ ok: false, reason: 'bad_signature' });
    });

    it('rejects when payload has been tampered (b64 modified after signing)', () => {
      const token = mintCallbackToken(SECRET, payload());
      const [b64, mac] = token.split('.');
      const tamperedB64 =
        Buffer.from(
          JSON.stringify(payload({ sigcoreWorkspaceId: 'ws_attacker' })),
          'utf8',
        ).toString('base64url');
      expect(tamperedB64).not.toBe(b64);
      const tampered = `${tamperedB64}.${mac}`;
      const result = verifyCallbackToken({
        secret: SECRET,
        token: tampered,
        expectedKind: 'recording_status',
        nowSeconds: NOW,
      });
      expect(result).toEqual({ ok: false, reason: 'bad_signature' });
    });

    it('rejects an expired token', () => {
      const token = mintCallbackToken(
        SECRET,
        payload({ exp: NOW - 1 }),
      );
      const result = verifyCallbackToken({
        secret: SECRET,
        token,
        expectedKind: 'recording_status',
        nowSeconds: NOW,
      });
      expect(result).toEqual({ ok: false, reason: 'expired' });
    });

    it('rejects a recording_status token presented on the call_status route', () => {
      const token = mintCallbackToken(
        SECRET,
        payload({ kind: 'recording_status' }),
      );
      const result = verifyCallbackToken({
        secret: SECRET,
        token,
        expectedKind: 'call_status',
        nowSeconds: NOW,
      });
      expect(result).toEqual({ ok: false, reason: 'wrong_kind' });
    });

    it('rejects a call_status token presented on the recording_status route', () => {
      const token = mintCallbackToken(
        SECRET,
        payload({ kind: 'call_status', callioCallId: undefined }),
      );
      const result = verifyCallbackToken({
        secret: SECRET,
        token,
        expectedKind: 'recording_status',
        nowSeconds: NOW,
      });
      expect(result).toEqual({ ok: false, reason: 'wrong_kind' });
    });

    it('rejects a payload with a missing required field', () => {
      // Manually mint a base64-encoded payload missing sigcoreWorkspaceId
      const bad = {
        v: 1 as const,
        kind: 'recording_status' as const,
        sigcoreTenantId: 'tn',
        callioDestUrl: 'https://callio.example/x',
        exp: FUTURE,
      };
      const b64 = Buffer.from(JSON.stringify(bad), 'utf8').toString('base64url');
      const crypto = require('crypto');
      const mac = crypto.createHmac('sha256', SECRET).update(b64, 'utf8').digest('hex');
      const token = `${b64}.${mac}`;
      const result = verifyCallbackToken({
        secret: SECRET,
        token,
        expectedKind: 'recording_status',
        nowSeconds: NOW,
      });
      expect(result).toEqual({ ok: false, reason: 'malformed_payload' });
    });

    it('rejects a payload with wrong version', () => {
      const b64 = Buffer.from(
        JSON.stringify({ ...payload(), v: 2 }),
        'utf8',
      ).toString('base64url');
      const crypto = require('crypto');
      const mac = crypto.createHmac('sha256', SECRET).update(b64, 'utf8').digest('hex');
      const token = `${b64}.${mac}`;
      const result = verifyCallbackToken({
        secret: SECRET,
        token,
        expectedKind: 'recording_status',
        nowSeconds: NOW,
      });
      expect(result).toEqual({ ok: false, reason: 'malformed_payload' });
    });
  });
});
