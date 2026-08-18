import type { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { EmailService } from '../email/email.service';
import {
  TenantVoiceForwarderService,
  ForwardInput,
} from './tenant-voice-forwarder.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios> & {
  isAxiosError: (val: unknown) => boolean;
};

const cfg = (overrides: Record<string, string | undefined> = {}) =>
  ({
    get: <T = string>(k: string): T | undefined =>
      overrides[k] as T | undefined,
  }) as unknown as ConfigService;

function makeEmail(): jest.Mocked<EmailService> {
  return {
    sendVoiceForwardFailureAlert: jest.fn(async () => true),
    sendInvitationEmail: jest.fn(async () => true),
  } as unknown as jest.Mocked<EmailService>;
}

const CORR = {
  workspaceId: 'ws-1',
  tenantId: 'tenant-1',
  providerCallSid: 'CA_test',
  environment: 'test',
};

const validTwiml =
  '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Hi</Say></Response>';

function baseInput(): ForwardInput {
  return {
    voiceInboundUrl: 'https://tenant.example/twilio/inbound',
    rawBody: 'CallSid=CA_test&From=%2B15551234567&To=%2B15550000000',
    contentType: 'application/x-www-form-urlencoded',
    twilioSignature: 'sig-xyz',
    forwardedHeaders: {
      'x-forwarded-for': '1.2.3.4',
      'x-forwarded-proto': 'https',
    },
    correlation: CORR,
  };
}

describe('TenantVoiceForwarderService.forward', () => {
  const originalIsAxiosError = axios.isAxiosError;
  beforeEach(() => {
    jest.clearAllMocks();
    // jest.mock replaces isAxiosError with a stub; restore the real one so
    // classifyAxiosError works on synthesized AxiosError-shaped objects.
    (mockedAxios as unknown as { isAxiosError: unknown }).isAxiosError =
      originalIsAxiosError;
  });

  const build = (env: Record<string, string | undefined> = {}) =>
    new TenantVoiceForwarderService(cfg(env), makeEmail());

  it('success — returns tenant TwiML byte-for-byte with outcome=success', async () => {
    const svc = build();
    mockedAxios.request.mockResolvedValueOnce({
      status: 200,
      data: validTwiml,
      headers: { 'content-type': 'application/xml' },
    } as any);
    const result = await svc.forward(baseInput());
    expect(result.outcome).toBe('success');
    if (result.outcome !== 'success') return;
    expect(result.twiml).toBe(validTwiml);
    expect(result.statusCode).toBe(200);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('preserves Twilio body verbatim (data param equals input rawBody)', async () => {
    const svc = build();
    mockedAxios.request.mockResolvedValueOnce({
      status: 200,
      data: validTwiml,
      headers: {},
    } as any);
    const input = baseInput();
    await svc.forward(input);
    const args = (mockedAxios.request as jest.Mock).mock.calls[0][0];
    expect(args.data).toBe(input.rawBody);
    expect(args.method).toBe('POST');
    expect(args.url).toBe(input.voiceInboundUrl);
  });

  describe('Wave-2 forwarded HMAC envelope', () => {
    it('adds x-sigcore-forwarded-signature + timestamp when the secret is set', async () => {
      const svc = build({ SIGCORE_VOICE_FORWARD_HMAC_SECRET: 'shared-secret-32chars-yay-hmac!!!!' });
      mockedAxios.request.mockResolvedValueOnce({
        status: 200,
        data: validTwiml,
        headers: {},
      } as any);
      await svc.forward(baseInput());
      const args = (mockedAxios.request as jest.Mock).mock.calls[0][0];
      expect(args.headers['x-sigcore-forwarded-signature']).toMatch(/^v1=[0-9a-f]{64}$/);
      const ts = Number(args.headers['x-sigcore-forwarded-timestamp']);
      expect(Number.isFinite(ts)).toBe(true);
      expect(Math.abs(Date.now() / 1000 - ts)).toBeLessThan(5);
    });

    it('omits signature + timestamp headers when the secret is unset', async () => {
      const svc = build();
      mockedAxios.request.mockResolvedValueOnce({
        status: 200,
        data: validTwiml,
        headers: {},
      } as any);
      await svc.forward(baseInput());
      const args = (mockedAxios.request as jest.Mock).mock.calls[0][0];
      expect(args.headers['x-sigcore-forwarded-signature']).toBeUndefined();
      expect(args.headers['x-sigcore-forwarded-timestamp']).toBeUndefined();
      // Correlation headers still forwarded regardless of secret state.
      expect(args.headers['x-sigcore-forwarded-workspace-id']).toBe('ws-1');
      expect(args.headers['x-sigcore-forwarded-tenant-id']).toBe('tenant-1');
      expect(args.headers['x-sigcore-forwarded-call-sid']).toBe('CA_test');
    });

    it('signature validates against a manually-computed HMAC over the canonical string', async () => {
      const secret = 'shared-secret-32chars-yay-hmac!!!!';
      const svc = build({ SIGCORE_VOICE_FORWARD_HMAC_SECRET: secret });
      mockedAxios.request.mockResolvedValueOnce({
        status: 200,
        data: validTwiml,
        headers: {},
      } as any);
      const input = baseInput();
      await svc.forward(input);
      const args = (mockedAxios.request as jest.Mock).mock.calls[0][0];
      const ts = args.headers['x-sigcore-forwarded-timestamp'];
      const nonce = args.headers['x-sigcore-forwarded-nonce'];
      const receivedSig = args.headers['x-sigcore-forwarded-signature'];

      // Independent recomputation — proves interop with any verifier that
      // follows the documented 9-line canonical form (Phase B.1 added the
      // nonce line between timestamp and workspaceId for replay protection).
      const crypto = require('crypto');
      const bodyHash = crypto.createHash('sha256').update(input.rawBody as string, 'utf8').digest('hex');
      const canonical = [
        'POST',
        '/twilio/inbound', // pathname of https://tenant.example/twilio/inbound
        'voice_inbound',
        ts,
        nonce,
        'ws-1',
        'tenant-1',
        'CA_test',
        bodyHash,
      ].join('\n');
      const expected = 'v1=' + crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
      expect(receivedSig).toBe(expected);
    });
  });

  it('preserves x-twilio-signature and only x-forwarded-* headers', async () => {
    const svc = build();
    mockedAxios.request.mockResolvedValueOnce({
      status: 200,
      data: validTwiml,
      headers: {},
    } as any);
    const input = baseInput();
    input.forwardedHeaders = {
      'x-forwarded-for': '1.2.3.4',
      'x-forwarded-proto': 'https',
      // Not an x-forwarded-* header — must be dropped.
      cookie: 'secret=abcdef',
    };
    await svc.forward(input);
    const args = (mockedAxios.request as jest.Mock).mock.calls[0][0];
    expect(args.headers['x-twilio-signature']).toBe('sig-xyz');
    expect(args.headers['x-forwarded-for']).toBe('1.2.3.4');
    expect(args.headers['x-forwarded-proto']).toBe('https');
    expect(args.headers.cookie).toBeUndefined();
  });

  it('uses 5s timeout by default; VOICE_FORWARD_TIMEOUT_MS overrides', async () => {
    const defaultSvc = build();
    mockedAxios.request.mockResolvedValue({
      status: 200,
      data: validTwiml,
      headers: {},
    } as any);
    await defaultSvc.forward(baseInput());
    expect((mockedAxios.request as jest.Mock).mock.calls[0][0].timeout).toBe(
      5000,
    );

    const customSvc = build({ VOICE_FORWARD_TIMEOUT_MS: '1500' });
    await customSvc.forward(baseInput());
    expect((mockedAxios.request as jest.Mock).mock.calls[1][0].timeout).toBe(
      1500,
    );
  });

  it('makes exactly one HTTP request per forward call (no retries)', async () => {
    const svc = build();
    mockedAxios.request.mockRejectedValueOnce(
      Object.assign(new Error('boom'), {
        isAxiosError: true,
        code: 'ECONNABORTED',
      }),
    );
    await svc.forward(baseInput());
    expect(mockedAxios.request).toHaveBeenCalledTimes(1);
  });

  describe('2026-08-17 — effective-caller header', () => {
    it('adds x-sigcore-forwarded-effective-caller when effectiveCallerNumber is set', async () => {
      const svc = build();
      mockedAxios.request.mockResolvedValueOnce({
        status: 200,
        data: validTwiml,
        headers: {},
      } as any);
      await svc.forward({ ...baseInput(), effectiveCallerNumber: '+19547163388' });
      const args = (mockedAxios.request as jest.Mock).mock.calls[0][0];
      expect(args.headers['x-sigcore-forwarded-effective-caller']).toBe('+19547163388');
    });

    it('omits the header when effectiveCallerNumber is not set (backward compat)', async () => {
      const svc = build();
      mockedAxios.request.mockResolvedValueOnce({
        status: 200,
        data: validTwiml,
        headers: {},
      } as any);
      await svc.forward(baseInput());
      const args = (mockedAxios.request as jest.Mock).mock.calls[0][0];
      expect(args.headers['x-sigcore-forwarded-effective-caller']).toBeUndefined();
    });

    it('omits the header when effectiveCallerNumber is an empty string', async () => {
      const svc = build();
      mockedAxios.request.mockResolvedValueOnce({
        status: 200,
        data: validTwiml,
        headers: {},
      } as any);
      await svc.forward({ ...baseInput(), effectiveCallerNumber: '' });
      const args = (mockedAxios.request as jest.Mock).mock.calls[0][0];
      expect(args.headers['x-sigcore-forwarded-effective-caller']).toBeUndefined();
    });
  });

  describe('failure classification', () => {
    const ambiguous = (code: string, reason: string) =>
      it(`code ${code} → ambiguous fallback reason=${reason}`, async () => {
        const svc = build();
        mockedAxios.request.mockRejectedValueOnce(
          Object.assign(new Error('boom'), { isAxiosError: true, code }),
        );
        const result = await svc.forward(baseInput());
        expect(result.outcome).toBe('fallback');
        if (result.outcome !== 'fallback') return;
        expect(result.category).toBe('ambiguous');
        expect(result.reason).toBe(reason);
      });

    ambiguous('ECONNABORTED', 'timeout');
    ambiguous('ETIMEDOUT', 'timeout');
    ambiguous('ENOTFOUND', 'dns');
    ambiguous('EAI_AGAIN', 'dns');
    ambiguous('ECONNREFUSED', 'connection_refused');
    ambiguous('ECONNRESET', 'network_reset');
    ambiguous('CERT_HAS_EXPIRED', 'tls');
    ambiguous('UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls');
    ambiguous('DEPTH_ZERO_SELF_SIGNED_CERT', 'tls');

    it('HTTP 400 → definite fallback', async () => {
      const svc = build();
      mockedAxios.request.mockRejectedValueOnce(
        Object.assign(new Error('bad'), {
          isAxiosError: true,
          response: { status: 400 },
        }),
      );
      const result = await svc.forward(baseInput());
      expect(result.outcome).toBe('fallback');
      if (result.outcome !== 'fallback') return;
      expect(result.category).toBe('definite');
      expect(result.reason).toBe('response_400');
      expect(result.statusCode).toBe(400);
    });

    it.each([
      [401, 'response_401'],
      [403, 'response_403'],
      [404, 'response_404'],
    ])('HTTP %i → definite fallback', async (status, reason) => {
      const svc = build();
      mockedAxios.request.mockRejectedValueOnce(
        Object.assign(new Error('x'), {
          isAxiosError: true,
          response: { status },
        }),
      );
      const result = await svc.forward(baseInput());
      expect(result.outcome).toBe('fallback');
      if (result.outcome !== 'fallback') return;
      expect(result.category).toBe('definite');
      expect(result.reason).toBe(reason);
    });

    it('axios maxContentLength violation → oversized_response (ambiguous)', async () => {
      // Regression for Stage 1 finding: axios aborts mid-download when the
      // response exceeds `maxContentLength`, so validateTwimlShape's size
      // guard never fires in production. Prior to the classifier fix this
      // was reported as `network_reset`. It must be `oversized_response`.
      const svc = build();
      mockedAxios.request.mockRejectedValueOnce(
        Object.assign(
          new Error('maxContentLength size of 65536 exceeded'),
          { isAxiosError: true, code: 'ERR_BAD_RESPONSE' },
        ),
      );
      const result = await svc.forward(baseInput());
      expect(result.outcome).toBe('fallback');
      if (result.outcome !== 'fallback') return;
      expect(result.category).toBe('ambiguous');
      expect(result.reason).toBe('oversized_response');
    });

    it('HTTP 500 → ambiguous fallback', async () => {
      const svc = build();
      mockedAxios.request.mockRejectedValueOnce(
        Object.assign(new Error('bad'), {
          isAxiosError: true,
          response: { status: 500 },
        }),
      );
      const result = await svc.forward(baseInput());
      expect(result.outcome).toBe('fallback');
      if (result.outcome !== 'fallback') return;
      expect(result.category).toBe('ambiguous');
      expect(result.reason).toBe('response_5xx');
      expect(result.statusCode).toBe(500);
    });
  });

  describe('response body validation', () => {
    it('empty response → ambiguous fallback reason=empty_response', async () => {
      const svc = build();
      mockedAxios.request.mockResolvedValueOnce({
        status: 200,
        data: '',
        headers: {},
      } as any);
      const result = await svc.forward(baseInput());
      expect(result.outcome).toBe('fallback');
      if (result.outcome !== 'fallback') return;
      expect(result.reason).toBe('empty_response');
    });

    it('malformed XML (missing closing tag) → malformed_xml', async () => {
      const svc = build();
      mockedAxios.request.mockResolvedValueOnce({
        status: 200,
        data: '<Response><Say>Hi</Say>',
        headers: {},
      } as any);
      const result = await svc.forward(baseInput());
      expect(result.outcome).toBe('fallback');
      if (result.outcome !== 'fallback') return;
      expect(result.reason).toBe('malformed_xml');
    });

    it('non-TwiML root (HTML) → not_twiml_root', async () => {
      const svc = build();
      mockedAxios.request.mockResolvedValueOnce({
        status: 200,
        data: '<html><body>err</body></html>',
        headers: {},
      } as any);
      const result = await svc.forward(baseInput());
      expect(result.outcome).toBe('fallback');
      if (result.outcome !== 'fallback') return;
      expect(result.reason).toBe('not_twiml_root');
    });

    it('oversized response → oversized_response', async () => {
      const svc = build({ VOICE_FORWARD_MAX_RESPONSE_BYTES: '128' });
      const big =
        '<Response>' + 'a'.repeat(200) + '</Response>';
      mockedAxios.request.mockResolvedValueOnce({
        status: 200,
        data: big,
        headers: {},
      } as any);
      const result = await svc.forward(baseInput());
      expect(result.outcome).toBe('fallback');
      if (result.outcome !== 'fallback') return;
      expect(result.reason).toBe('oversized_response');
    });
  });

  describe('alerting', () => {
    it('fires alert on failure (fire-and-forget)', async () => {
      const email = makeEmail();
      const svc = new TenantVoiceForwarderService(cfg({}), email);
      mockedAxios.request.mockRejectedValueOnce(
        Object.assign(new Error('boom'), {
          isAxiosError: true,
          code: 'ECONNABORTED',
        }),
      );
      await svc.forward(baseInput());
      await new Promise((r) => setImmediate(r));
      expect(email.sendVoiceForwardFailureAlert).toHaveBeenCalledTimes(1);
      const arg = (email.sendVoiceForwardFailureAlert as jest.Mock).mock
        .calls[0][0];
      expect(arg.reason).toBe('timeout');
      expect(arg.category).toBe('ambiguous');
      expect(arg.tenantId).toBe('tenant-1');
    });

    it('does NOT fire alert on success', async () => {
      const email = makeEmail();
      const svc = new TenantVoiceForwarderService(cfg({}), email);
      mockedAxios.request.mockResolvedValueOnce({
        status: 200,
        data: validTwiml,
        headers: {},
      } as any);
      await svc.forward(baseInput());
      await new Promise((r) => setImmediate(r));
      expect(email.sendVoiceForwardFailureAlert).not.toHaveBeenCalled();
    });

    it('alert delivery failure does not affect returned ForwardResult', async () => {
      const email = makeEmail();
      (email.sendVoiceForwardFailureAlert as jest.Mock).mockRejectedValueOnce(
        new Error('mailer down'),
      );
      const svc = new TenantVoiceForwarderService(cfg({}), email);
      mockedAxios.request.mockRejectedValueOnce(
        Object.assign(new Error('boom'), {
          isAxiosError: true,
          code: 'ECONNABORTED',
        }),
      );
      const result = await svc.forward(baseInput());
      expect(result.outcome).toBe('fallback');
    });
  });
});
