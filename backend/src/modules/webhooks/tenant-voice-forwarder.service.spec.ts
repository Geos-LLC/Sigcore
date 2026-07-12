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
