/**
 * G-6 CSC (2026-08-22, post-security-review) — TenantVoiceForwarderService
 * capability-mint tests.
 *
 * Sigcore is the sole capability issuer. This spec pins:
 *
 *   1. When both `SIGCORE_CALL_CAPABILITY_SECRET` and `originatingIntegrationId`
 *      are supplied → header injected + capability round-trips through
 *      verifyCallCapability.
 *   2. When secret is unset (rollout state before env var is set) → no
 *      capability header injected + envelope still forwards (backward-compat).
 *   3. When originatingIntegrationId is missing (integration lookup returned
 *      null) → no capability header + envelope still forwards.
 *   4. Log lines NEVER contain the capability value, signature, or full
 *      payload — only outcome + reason + ids.
 */
import type { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { TenantVoiceForwarderService } from './tenant-voice-forwarder.service';
import {
  verifyCallCapability,
  CSC_HEADER_NAME,
} from '../../common/guards/call-scoped-capability.util';

jest.mock('axios');
const axiosMocked = axios as jest.Mocked<typeof axios>;

const SIGCORE_SECRET = 'sigcore-only-capability-secret-32b-!';
const CALL_SID = 'CAcapability_forward_e2e';
const INTEGRATION_ID = 'a537cc3a-5c62-4f11-aff8-50fa840ef7a2';
const WORKSPACE_ID = '1bcbb4e0-df1b-481c-83ba-0730df47a720';
const TENANT_ID = '38380c75-1876-4984-b194-5fda7529835c';

function makeCfg(values: Record<string, string | undefined>): ConfigService {
  return {
    get: <T = string>(k: string): T | undefined => values[k] as T | undefined,
  } as unknown as ConfigService;
}

const noopEmail = {
  sendVoiceForwardFailureAlert: jest.fn(async () => true),
} as any;

const baseInput = () => ({
  voiceInboundUrl: 'https://callio.test/webhooks/twilio/voice/ws',
  rawBody: 'CallSid=CA_test&From=%2B1',
  contentType: 'application/x-www-form-urlencoded',
  twilioSignature: 'sig',
  forwardedHeaders: {},
  correlation: {
    workspaceId: WORKSPACE_ID,
    tenantId: TENANT_ID,
    providerCallSid: CALL_SID,
    environment: 'test',
  },
});

beforeEach(() => {
  axiosMocked.request.mockReset();
  axiosMocked.request.mockResolvedValue({
    status: 200,
    data: '<?xml version="1.0" encoding="UTF-8"?><Response><Say>ok</Say></Response>',
    headers: { 'content-type': 'application/xml' },
  } as any);
});

describe('TenantVoiceForwarderService — G-6 CSC mint', () => {
  it('mints a capability + injects X-Sigcore-Call-Capability when secret + integrationId present', async () => {
    const svc = new TenantVoiceForwarderService(
      makeCfg({ SIGCORE_CALL_CAPABILITY_SECRET: SIGCORE_SECRET }),
      noopEmail,
    );
    const result = await svc.forward({
      ...baseInput(),
      originatingIntegrationId: INTEGRATION_ID,
    });
    expect(result.outcome).toBe('success');

    // Header must be on the outbound axios request.
    const requestArgs = axiosMocked.request.mock.calls[0][0] as any;
    const header = requestArgs.headers[CSC_HEADER_NAME];
    expect(typeof header).toBe('string');
    expect(header.startsWith('v1.')).toBe(true);

    // Capability must round-trip through the verifier (sole verifier is
    // Sigcore's IntegrationResourceGuard; here we exercise the util
    // directly to prove the mint produced a well-formed signed payload).
    const verify = verifyCallCapability({
      headerValue: header,
      secret: SIGCORE_SECRET,
      expectedOperation: 'call.hangup',
      expectedCallSid: CALL_SID,
    });
    expect(verify.outcome).toBe('ok');
    if (verify.outcome === 'ok') {
      expect(verify.payload.callSid).toBe(CALL_SID);
      expect(verify.payload.integrationId).toBe(INTEGRATION_ID);
      expect(verify.payload.allowedOps).toEqual(
        expect.arrayContaining(['call.hangup', 'call.recording.start', 'call.recording.stop']),
      );
      // Sigcore-decided TTL — exactly 6 hours per milestone signoff.
      expect(verify.payload.exp - verify.payload.iat).toBe(6 * 3600);
    }
  });

  it('does NOT inject the capability header when secret is unset (backward-compat)', async () => {
    const svc = new TenantVoiceForwarderService(makeCfg({}), noopEmail);
    const result = await svc.forward({
      ...baseInput(),
      originatingIntegrationId: INTEGRATION_ID,
    });
    expect(result.outcome).toBe('success');

    const requestArgs = axiosMocked.request.mock.calls[0][0] as any;
    expect(requestArgs.headers[CSC_HEADER_NAME]).toBeUndefined();
  });

  it('does NOT inject the capability header when originatingIntegrationId is missing', async () => {
    const svc = new TenantVoiceForwarderService(
      makeCfg({ SIGCORE_CALL_CAPABILITY_SECRET: SIGCORE_SECRET }),
      noopEmail,
    );
    const result = await svc.forward({
      ...baseInput(),
      originatingIntegrationId: null,
    });
    expect(result.outcome).toBe('success');

    const requestArgs = axiosMocked.request.mock.calls[0][0] as any;
    expect(requestArgs.headers[CSC_HEADER_NAME]).toBeUndefined();
  });

  it('log line for the mint does NOT contain the capability value, signature, or payload', async () => {
    const svc = new TenantVoiceForwarderService(
      makeCfg({ SIGCORE_CALL_CAPABILITY_SECRET: SIGCORE_SECRET }),
      noopEmail,
    );
    const loggerSpy = jest.spyOn((svc as any).logger, 'log');
    await svc.forward({
      ...baseInput(),
      originatingIntegrationId: INTEGRATION_ID,
    });

    // Find the csc_capability_minted line.
    const mintLine = loggerSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.startsWith('csc_capability_minted'));
    expect(mintLine).toBeDefined();
    // Extract the capability from the request headers we intercepted.
    const requestArgs = axiosMocked.request.mock.calls[0][0] as any;
    const capability = requestArgs.headers[CSC_HEADER_NAME] as string;
    const [, payloadB64, sigB64] = capability.split('.');

    // Redaction assertions — the log line must not leak any part of the
    // capability, signature, or payload bytes.
    expect(mintLine).not.toContain(capability);
    expect(mintLine).not.toContain(payloadB64);
    expect(mintLine).not.toContain(sigB64);
    expect(mintLine).not.toContain(SIGCORE_SECRET);
    // Sanity: it SHOULD contain the correlation ids so operators can trace.
    expect(mintLine).toContain(CALL_SID);
    expect(mintLine).toContain(INTEGRATION_ID);
    expect(mintLine).toContain('ttlSec=21600');
  });
});
