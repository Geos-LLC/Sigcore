import { CallbackForwarderService } from './callback-forwarder.service';
import { verifyCallbackToken } from './sigcore-callback-token.util';
import {
  SIGCORE_FORWARD_HEADERS,
  verify as verifyForwardEnvelope,
} from './sigcore-forward-signature.util';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as unknown as { request: jest.Mock };

function makeService(secret: string | undefined) {
  const config = {
    get: (k: string) =>
      k === 'SIGCORE_VOICE_FORWARD_HMAC_SECRET' ? secret : undefined,
  } as any;
  return new CallbackForwarderService(config);
}

const SECRET = 'sigcore-forward-hmac-secret';

beforeEach(() => {
  jest.clearAllMocks();
  mockedAxios.request = jest.fn();
});

describe('CallbackForwarderService', () => {
  describe('isArmed', () => {
    it('is armed when SIGCORE_VOICE_FORWARD_HMAC_SECRET is present', () => {
      expect(makeService(SECRET).isArmed()).toBe(true);
    });

    it('is not armed when SIGCORE_VOICE_FORWARD_HMAC_SECRET is missing', () => {
      expect(makeService(undefined).isArmed()).toBe(false);
    });
  });

  describe('mintToken + verify roundtrip', () => {
    it('returns null when no secret configured', () => {
      const svc = makeService(undefined);
      const token = svc.mintToken({
        kind: 'recording_status',
        sigcoreWorkspaceId: 'ws',
        sigcoreTenantId: 'tn',
        callioDestUrl: 'https://callio.example/x',
      });
      expect(token).toBeNull();
    });

    it('mints a token that verifies with the same secret and expected kind', () => {
      const svc = makeService(SECRET);
      const token = svc.mintToken({
        kind: 'recording_status',
        sigcoreWorkspaceId: 'ws_a',
        sigcoreTenantId: 'tn_b',
        callioDestUrl: 'https://callio.example/api/webhooks/twilio/recording-status/call_1',
        callioCallId: 'call_1',
      });
      expect(token).toBeTruthy();
      const result = verifyCallbackToken({
        secret: SECRET,
        token: token!,
        expectedKind: 'recording_status',
        nowSeconds: Math.floor(Date.now() / 1000),
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.sigcoreWorkspaceId).toBe('ws_a');
        expect(result.payload.callioCallId).toBe('call_1');
      }
    });

    it('honors ttlSeconds override', () => {
      const svc = makeService(SECRET);
      const token = svc.mintToken({
        kind: 'call_status',
        sigcoreWorkspaceId: 'ws',
        sigcoreTenantId: 'tn',
        callioDestUrl: 'https://callio.example/x',
        ttlSeconds: 60,
      });
      expect(token).toBeTruthy();
      const now = Math.floor(Date.now() / 1000);
      const result = verifyCallbackToken({
        secret: SECRET,
        token: token!,
        expectedKind: 'call_status',
        nowSeconds: now,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.exp - now).toBeLessThanOrEqual(60);
        expect(result.payload.exp - now).toBeGreaterThan(0);
      }
    });
  });

  describe('eventTypeForKind', () => {
    it('maps recording_status -> voice_recording_status', () => {
      expect(makeService(SECRET).eventTypeForKind('recording_status')).toBe(
        'voice_recording_status',
      );
    });
    it('maps call_status -> voice_call_status', () => {
      expect(makeService(SECRET).eventTypeForKind('call_status')).toBe(
        'voice_call_status',
      );
    });
  });

  describe('forward', () => {
    it('short-circuits with fallback when no secret configured', async () => {
      const svc = makeService(undefined);
      const result = await svc.forward({
        eventType: 'voice_recording_status',
        callioDestUrl: 'https://callio.example/api/webhooks/twilio/recording-status/call_1',
        sigcoreWorkspaceId: 'ws',
        sigcoreTenantId: 'tn',
        providerCallSid: 'CA123',
        rawBody: Buffer.from('CallSid=CA123&RecordingSid=RE1'),
        contentType: 'application/x-www-form-urlencoded',
      });
      expect(result.outcome).toBe('fallback');
      expect(result.reason).toBe('hmac_secret_not_configured');
      expect(mockedAxios.request).not.toHaveBeenCalled();
    });

    it('POSTs to callioDestUrl with all HMAC headers on the happy path', async () => {
      mockedAxios.request.mockResolvedValueOnce({ status: 200, data: '' });
      const svc = makeService(SECRET);
      const rawBody = Buffer.from(
        'CallSid=CA123&RecordingSid=RE_ABC&RecordingUrl=https%3A%2F%2Fapi.twilio.com%2Frec',
      );
      const result = await svc.forward({
        eventType: 'voice_recording_status',
        callioDestUrl: 'https://callio.example/api/webhooks/twilio/recording-status/call_1',
        sigcoreWorkspaceId: 'ws_a',
        sigcoreTenantId: 'tn_b',
        providerCallSid: 'CA123',
        rawBody,
        contentType: 'application/x-www-form-urlencoded',
        twilioSignature: 'sigOriginal',
      });

      expect(result.outcome).toBe('success');
      expect(result.statusCode).toBe(200);
      expect(mockedAxios.request).toHaveBeenCalledTimes(1);
      const call = mockedAxios.request.mock.calls[0][0];
      expect(call.method).toBe('POST');
      expect(call.url).toBe(
        'https://callio.example/api/webhooks/twilio/recording-status/call_1',
      );
      expect(call.data).toBe(rawBody);

      const headers = call.headers as Record<string, string>;
      expect(headers[SIGCORE_FORWARD_HEADERS.workspaceId]).toBe('ws_a');
      expect(headers[SIGCORE_FORWARD_HEADERS.tenantId]).toBe('tn_b');
      expect(headers[SIGCORE_FORWARD_HEADERS.callSid]).toBe('CA123');
      expect(headers[SIGCORE_FORWARD_HEADERS.eventType]).toBe(
        'voice_recording_status',
      );
      expect(headers[SIGCORE_FORWARD_HEADERS.timestamp]).toMatch(/^\d+$/);
      expect(headers[SIGCORE_FORWARD_HEADERS.signature]).toMatch(/^v1=[0-9a-f]{64}$/);
      expect(headers['x-twilio-signature']).toBe('sigOriginal');

      // Verify the signature is valid against Callio's verifier logic
      const verify = verifyForwardEnvelope({
        secret: SECRET,
        headers: {
          signature: headers[SIGCORE_FORWARD_HEADERS.signature],
          timestamp: headers[SIGCORE_FORWARD_HEADERS.timestamp],
          workspaceId: headers[SIGCORE_FORWARD_HEADERS.workspaceId],
          tenantId: headers[SIGCORE_FORWARD_HEADERS.tenantId],
          callSid: headers[SIGCORE_FORWARD_HEADERS.callSid],
          eventType: headers[SIGCORE_FORWARD_HEADERS.eventType],
        },
        expectedEventType: 'voice_recording_status',
        method: 'POST',
        path: '/api/webhooks/twilio/recording-status/call_1',
        rawBody,
        nowSeconds: Math.floor(Date.now() / 1000),
      });
      expect(verify.ok).toBe(true);
    });

    it('classifies Callio non-2xx as fallback with response_<status> reason', async () => {
      const err: any = new Error('bad');
      err.response = { status: 502 };
      mockedAxios.request.mockRejectedValueOnce(err);
      const svc = makeService(SECRET);
      const result = await svc.forward({
        eventType: 'voice_call_status',
        callioDestUrl: 'https://callio.example/api/webhooks/twilio/call-status/call_2',
        sigcoreWorkspaceId: 'ws',
        sigcoreTenantId: 'tn',
        providerCallSid: 'CA9',
        rawBody: Buffer.from('CallSid=CA9&CallStatus=completed'),
        contentType: 'application/x-www-form-urlencoded',
      });
      expect(result.outcome).toBe('fallback');
      expect(result.statusCode).toBe(502);
      expect(result.reason).toBe('response_502');
    });

    it('classifies network error as fallback with err.code as reason', async () => {
      const err: any = new Error('econnreset');
      err.code = 'ECONNRESET';
      mockedAxios.request.mockRejectedValueOnce(err);
      const svc = makeService(SECRET);
      const result = await svc.forward({
        eventType: 'voice_recording_status',
        callioDestUrl: 'https://callio.example/x/call_3',
        sigcoreWorkspaceId: 'ws',
        sigcoreTenantId: 'tn',
        providerCallSid: 'CA_x',
        rawBody: Buffer.from('CallSid=CA_x'),
        contentType: 'application/x-www-form-urlencoded',
      });
      expect(result.outcome).toBe('fallback');
      expect(result.reason).toBe('ECONNRESET');
    });

    it('canonicalizes path from URL including search string', async () => {
      mockedAxios.request.mockResolvedValueOnce({ status: 200, data: '' });
      const svc = makeService(SECRET);
      const rawBody = Buffer.from('CallSid=CA1');
      await svc.forward({
        eventType: 'voice_call_status',
        callioDestUrl: 'https://callio.example/hook/abc?token=xyz',
        sigcoreWorkspaceId: 'ws',
        sigcoreTenantId: 'tn',
        providerCallSid: 'CA1',
        rawBody,
        contentType: 'application/x-www-form-urlencoded',
      });
      const headers = mockedAxios.request.mock.calls[0][0].headers as Record<string, string>;
      const verify = verifyForwardEnvelope({
        secret: SECRET,
        headers: {
          signature: headers[SIGCORE_FORWARD_HEADERS.signature],
          timestamp: headers[SIGCORE_FORWARD_HEADERS.timestamp],
          workspaceId: headers[SIGCORE_FORWARD_HEADERS.workspaceId],
          tenantId: headers[SIGCORE_FORWARD_HEADERS.tenantId],
          callSid: headers[SIGCORE_FORWARD_HEADERS.callSid],
          eventType: headers[SIGCORE_FORWARD_HEADERS.eventType],
        },
        expectedEventType: 'voice_call_status',
        method: 'POST',
        path: '/hook/abc?token=xyz',
        rawBody,
        nowSeconds: Math.floor(Date.now() / 1000),
      });
      expect(verify.ok).toBe(true);
    });
  });
});
