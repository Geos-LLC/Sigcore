import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import axios from 'axios';
import { PassThrough } from 'stream';
import { InternalTwilioProxyController } from './internal-twilio-proxy.controller';
import { ProviderType } from '../../database/entities';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const REAL_ACCOUNT_SID = 'AC00000000000000000000000000000001';
const OTHER_ACCOUNT_SID = 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REAL_URL = `https://api.twilio.com/2010-04-01/Accounts/${REAL_ACCOUNT_SID}/Recordings/REabc.mp3`;
const SERVICE_KEY = 'test-service-key';

function makeReq(overrides: Partial<{
  serviceKey: string | undefined;
  integrationId: string | undefined;
  tenantId: string | undefined;
  workspaceId: string | undefined;
  range: string | undefined;
}> = {}) {
  const headers: Record<string, string> = {};
  const svc = 'serviceKey' in overrides ? overrides.serviceKey : SERVICE_KEY;
  if (svc) headers['x-sigcore-key'] = svc;
  if (overrides.integrationId) headers['x-sigcore-integration-id'] = overrides.integrationId;
  if (overrides.tenantId) headers['x-sigcore-tenant-id'] = overrides.tenantId;
  if (overrides.workspaceId) headers['x-sigcore-workspace-id'] = overrides.workspaceId;
  if (overrides.range) headers['range'] = overrides.range;
  return { headers } as any;
}

function makeRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  // Use a PassThrough as the res so `upstream.data.pipe(res)` works — the
  // controller doesn't wait for the pipe to drain, so tests can inspect
  // statusCode / headers synchronously after the returned promise resolves.
  const res: any = new PassThrough();
  res.status = (c: number) => {
    statusCode = c;
    return res;
  };
  res.setHeader = (k: string, v: string) => {
    headers[k.toLowerCase()] = String(v);
  };
  res.getHeader = (k: string) => headers[k.toLowerCase()];
  res.__inspect = () => ({ statusCode, headers });
  return res;
}

function upstreamStream(status: number, respHeaders: Record<string, string> = {}) {
  const stream = new PassThrough();
  process.nextTick(() => {
    stream.write(Buffer.from([0xff, 0xf3, 0x80, 0x64]));
    stream.end();
  });
  return {
    status,
    headers: { 'content-type': 'audio/mpeg', ...respHeaders },
    data: stream,
  };
}

function makeCtrl(state: {
  integrations: any[];
  tenants: any[];
  serviceKey?: string | undefined;
}) {
  const integrationRepo = {
    findOne: jest.fn(({ where: { id } }: any) =>
      Promise.resolve(state.integrations.find((i) => i.id === id) ?? null),
    ),
    find: jest.fn(() => Promise.resolve(state.integrations)),
  };
  const tenantRepo = {
    findOne: jest.fn(({ where: { id } }: any) =>
      Promise.resolve(state.tenants.find((t) => t.id === id) ?? null),
    ),
  };
  const encryptionService = {
    // Test creds are stored as literal JSON — no real encrypt path.
    decrypt: (s: string) => s,
  };
  const configService = {
    get: (k: string) => (k === 'SIGCORE_SERVICE_KEY' ? state.serviceKey ?? SERVICE_KEY : undefined),
  };
  return new InternalTwilioProxyController(
    integrationRepo as any,
    tenantRepo as any,
    encryptionService as any,
    configService as any,
  );
}

const validIntegration = {
  id: 'int_1',
  workspaceId: 'ws_1',
  provider: ProviderType.TWILIO,
  credentialsEncrypted: JSON.stringify({
    accountSid: REAL_ACCOUNT_SID,
    authToken: 'auth-token-secret',
  }),
};
const validTenant = {
  id: 'tn_1',
  workspaceId: 'ws_1',
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('InternalTwilioProxyController', () => {
  describe('auth', () => {
    it('rejects when x-sigcore-key is missing', async () => {
      const ctrl = makeCtrl({ integrations: [], tenants: [] });
      const req = makeReq({ serviceKey: undefined });
      await expect(
        ctrl.streamRecording(REAL_URL, req, makeRes()),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects when x-sigcore-key does not match', async () => {
      const ctrl = makeCtrl({ integrations: [], tenants: [] });
      const req = makeReq({ serviceKey: 'wrong-key' });
      await expect(
        ctrl.streamRecording(REAL_URL, req, makeRes()),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('URL validation', () => {
    it('rejects a non-Twilio URL', async () => {
      const ctrl = makeCtrl({ integrations: [], tenants: [] });
      await expect(
        ctrl.streamRecording('https://evil.example/x', makeReq(), makeRes()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a Twilio URL with no Account SID segment', async () => {
      const ctrl = makeCtrl({ integrations: [], tenants: [] });
      await expect(
        ctrl.streamRecording('https://api.twilio.com/2010-04-01/Recordings/RE.mp3', makeReq(), makeRes()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('URL-scan mode (legacy)', () => {
    it('resolves credentials by scanning integrations and streams', async () => {
      const ctrl = makeCtrl({ integrations: [validIntegration], tenants: [] });
      mockedAxios.get.mockResolvedValue(upstreamStream(200));
      const res = makeRes();
      await ctrl.streamRecording(REAL_URL, makeReq(), res);
      expect(res.__inspect().statusCode).toBe(200);
      expect(res.__inspect().headers['content-type']).toBe('audio/mpeg');
      expect(mockedAxios.get).toHaveBeenCalledWith(
        REAL_URL,
        expect.objectContaining({
          auth: { username: REAL_ACCOUNT_SID, password: 'auth-token-secret' },
        }),
      );
    });

    it('404s when no integration matches the URL account SID', async () => {
      const ctrl = makeCtrl({
        integrations: [
          {
            ...validIntegration,
            credentialsEncrypted: JSON.stringify({
              accountSid: OTHER_ACCOUNT_SID,
              authToken: 'x',
            }),
          },
        ],
        tenants: [],
      });
      await expect(
        ctrl.streamRecording(REAL_URL, makeReq(), makeRes()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('scoped mode (Task 6B.5D)', () => {
    it('accepts when integration + tenant chain is valid and stream is returned', async () => {
      const ctrl = makeCtrl({
        integrations: [validIntegration],
        tenants: [validTenant],
      });
      mockedAxios.get.mockResolvedValue(
        upstreamStream(200, { 'content-length': '118909' }),
      );
      const res = makeRes();
      await ctrl.streamRecording(
        REAL_URL,
        makeReq({ integrationId: 'int_1', tenantId: 'tn_1' }),
        res,
      );
      expect(res.__inspect().statusCode).toBe(200);
      expect(res.__inspect().headers['content-length']).toBe('118909');
      // Auth uses the integration's decrypted creds
      expect(mockedAxios.get).toHaveBeenCalledWith(
        REAL_URL,
        expect.objectContaining({
          auth: { username: REAL_ACCOUNT_SID, password: 'auth-token-secret' },
        }),
      );
    });

    it('404s when integration not found', async () => {
      const ctrl = makeCtrl({ integrations: [], tenants: [validTenant] });
      await expect(
        ctrl.streamRecording(
          REAL_URL,
          makeReq({ integrationId: 'int_missing', tenantId: 'tn_1' }),
          makeRes(),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s when tenant not found', async () => {
      const ctrl = makeCtrl({ integrations: [validIntegration], tenants: [] });
      await expect(
        ctrl.streamRecording(
          REAL_URL,
          makeReq({ integrationId: 'int_1', tenantId: 'tn_missing' }),
          makeRes(),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects when integration provider is not TWILIO', async () => {
      const ctrl = makeCtrl({
        integrations: [{ ...validIntegration, provider: ProviderType.OPENPHONE }],
        tenants: [validTenant],
      });
      await expect(
        ctrl.streamRecording(
          REAL_URL,
          makeReq({ integrationId: 'int_1', tenantId: 'tn_1' }),
          makeRes(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects when workspace does not own tenant (cross-workspace attack)', async () => {
      const ctrl = makeCtrl({
        integrations: [validIntegration],
        tenants: [{ ...validTenant, workspaceId: 'ws_attacker' }],
      });
      await expect(
        ctrl.streamRecording(
          REAL_URL,
          makeReq({ integrationId: 'int_1', tenantId: 'tn_1' }),
          makeRes(),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rejects when URL account SID does not match integration account SID', async () => {
      const ctrl = makeCtrl({
        integrations: [
          {
            ...validIntegration,
            credentialsEncrypted: JSON.stringify({
              accountSid: OTHER_ACCOUNT_SID,
              authToken: 'x',
            }),
          },
        ],
        tenants: [validTenant],
      });
      await expect(
        ctrl.streamRecording(
          REAL_URL,
          makeReq({ integrationId: 'int_1', tenantId: 'tn_1' }),
          makeRes(),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404s when integration has no stored credentials', async () => {
      const ctrl = makeCtrl({
        integrations: [{ ...validIntegration, credentialsEncrypted: null }],
        tenants: [validTenant],
      });
      await expect(
        ctrl.streamRecording(
          REAL_URL,
          makeReq({ integrationId: 'int_1', tenantId: 'tn_1' }),
          makeRes(),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    // -------------------------------------------------------------------
    // Incident 2026-07-14 Phase 3a — cross-workspace integrationId hint.
    // -------------------------------------------------------------------

    it('cross_workspace_integrationId_hint_is_rejected — inline check without resolver', async () => {
      // Integration + tenant belong to ws_1; caller claims they belong to ws_2.
      // Before Phase 3a, the controller had no visibility of the caller's
      // workspace, so a caller with the shared service key could point at any
      // (integrationId, tenantId) pair in any workspace and receive that
      // subaccount's Twilio credentials. This test asserts the new inline
      // check throws 403 the moment `x-sigcore-workspace-id` differs from
      // the resolved integration's workspaceId — no resolver needed.
      const ctrl = makeCtrl({
        integrations: [validIntegration],
        tenants: [validTenant],
      });
      await expect(
        ctrl.streamRecording(
          REAL_URL,
          makeReq({
            integrationId: 'int_1',
            tenantId: 'tn_1',
            workspaceId: 'ws_attacker',
          }),
          makeRes(),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('same_workspace_integrationId_hint_succeeds', async () => {
      // Baseline pass: caller supplies matching workspaceId. Stream must
      // complete and Twilio auth headers must be the integration's real
      // creds.
      const ctrl = makeCtrl({
        integrations: [validIntegration],
        tenants: [validTenant],
      });
      mockedAxios.get.mockResolvedValue(upstreamStream(200));
      const res = makeRes();
      await ctrl.streamRecording(
        REAL_URL,
        makeReq({
          integrationId: 'int_1',
          tenantId: 'tn_1',
          workspaceId: 'ws_1',
        }),
        res,
      );
      expect(res.__inspect().statusCode).toBe(200);
      expect(mockedAxios.get).toHaveBeenCalledWith(
        REAL_URL,
        expect.objectContaining({
          auth: { username: REAL_ACCOUNT_SID, password: 'auth-token-secret' },
        }),
      );
    });

    it('same_workspace_integrationId_hint_succeeds — no workspaceId header (pre-3a back-compat)', async () => {
      // Pre-Phase-3a callers don't send x-sigcore-workspace-id; the
      // controller must still work exactly as before — the inline check is
      // skipped, the scoped guards fire, and the stream returns.
      const ctrl = makeCtrl({
        integrations: [validIntegration],
        tenants: [validTenant],
      });
      mockedAxios.get.mockResolvedValue(upstreamStream(200));
      const res = makeRes();
      await ctrl.streamRecording(
        REAL_URL,
        makeReq({ integrationId: 'int_1', tenantId: 'tn_1' }),
        res,
      );
      expect(res.__inspect().statusCode).toBe(200);
    });

    // -------------------------------------------------------------------
    // 2026-08-17 — cross-integration recording playback fix.
    //
    // Repro of the prod failure: pilot Callio workspace places calls via
    // a phone number provisioned by LeadBridge's Sigcore integration. The
    // call+recording live on LB's Twilio subaccount. Callio's Wave-4
    // stamps that LB integration on `voice_calls.communication_integration_id`
    // (so post-call ops route to the right account), and the recording
    // proxy call correctly forwards it as `x-sigcore-integration-id`.
    //
    // The integration and its tenant both live in the pilot workspace
    // (LB provisioned INTO the pilot workspace), so the inline
    // caller_workspace_mismatch check passes. The account_sid check also
    // passes because the integration's creds own the URL's account. But
    // the previous ProviderContextResolver call would resolve the
    // "default" integration for the (workspace, tenant, TWILIO) triple
    // to a DIFFERENT integration (the pilot's own, not LB's), and the
    // hint-mismatch check would 403.
    //
    // With the resolver call removed from this path, cross-integration
    // playback now succeeds — while the load-bearing security guarantees
    // (workspace-ownership + account_sid_match) still fire.
    // -------------------------------------------------------------------

    it('cross_integration_recording_playback_succeeds — LB-provisioned-number regression', async () => {
      // Two TWILIO integrations exist in ws_1 (pilot workspace):
      //   - `int_pilot_default` (workspace's own default; NOT the one that owns the recording)
      //   - `int_lb_provisioned` (LB-provisioned; DOES own the recording's Twilio account)
      // Callio hints `int_lb_provisioned` — the correct one for THIS
      // recording, even though the resolver's per-workspace default is
      // `int_pilot_default`.
      const lbProvisioned = {
        id: 'int_lb_provisioned',
        workspaceId: 'ws_1',
        provider: ProviderType.TWILIO,
        credentialsEncrypted: JSON.stringify({
          accountSid: REAL_ACCOUNT_SID,
          authToken: 'lb-auth-token',
        }),
      };
      const pilotDefault = {
        id: 'int_pilot_default',
        workspaceId: 'ws_1',
        provider: ProviderType.TWILIO,
        credentialsEncrypted: JSON.stringify({
          accountSid: OTHER_ACCOUNT_SID,
          authToken: 'pilot-auth-token',
        }),
      };
      const ctrl = makeCtrl({
        integrations: [pilotDefault, lbProvisioned],
        tenants: [validTenant],
      });
      mockedAxios.get.mockResolvedValue(upstreamStream(200));
      const res = makeRes();
      await ctrl.streamRecording(
        REAL_URL,
        makeReq({
          integrationId: 'int_lb_provisioned',
          tenantId: 'tn_1',
          workspaceId: 'ws_1',
        }),
        res,
      );
      expect(res.__inspect().statusCode).toBe(200);
      // Twilio auth uses the LB integration's creds (not the pilot default)
      expect(mockedAxios.get).toHaveBeenCalledWith(
        REAL_URL,
        expect.objectContaining({
          auth: { username: REAL_ACCOUNT_SID, password: 'lb-auth-token' },
        }),
      );
    });

    it('cross_workspace_integration_still_rejected_by_workspace_check', async () => {
      // Same setup as the fix-scenario above, EXCEPT the caller lies about
      // workspaceId. The inline caller_workspace_mismatch check must still
      // fire — removing the resolver check must NOT weaken this defense.
      const foreignIntegration = {
        id: 'int_foreign',
        workspaceId: 'ws_other', // integration lives in a different workspace
        provider: ProviderType.TWILIO,
        credentialsEncrypted: JSON.stringify({
          accountSid: REAL_ACCOUNT_SID,
          authToken: 'foreign-auth-token',
        }),
      };
      const ctrl = makeCtrl({
        integrations: [foreignIntegration],
        tenants: [{ id: 'tn_other', workspaceId: 'ws_other' }],
      });
      await expect(
        ctrl.streamRecording(
          REAL_URL,
          makeReq({
            integrationId: 'int_foreign',
            tenantId: 'tn_other',
            workspaceId: 'ws_1', // caller claims to be ws_1 — attacker
          }),
          makeRes(),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cross_integration_with_wrong_account_still_rejected_by_accountSid_check', async () => {
      // Cross-integration case, but the hinted integration's stored
      // accountSid does NOT match the URL's account. account_sid_mismatch
      // must still fire — the load-bearing security check for recording
      // playback remains intact.
      const mismatchedIntegration = {
        id: 'int_wrong_account',
        workspaceId: 'ws_1',
        provider: ProviderType.TWILIO,
        credentialsEncrypted: JSON.stringify({
          accountSid: OTHER_ACCOUNT_SID, // doesn't match REAL_URL's account
          authToken: 'x',
        }),
      };
      const ctrl = makeCtrl({
        integrations: [mismatchedIntegration],
        tenants: [validTenant],
      });
      await expect(
        ctrl.streamRecording(
          REAL_URL,
          makeReq({
            integrationId: 'int_wrong_account',
            tenantId: 'tn_1',
            workspaceId: 'ws_1',
          }),
          makeRes(),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('range forwarding + truthful propagation', () => {
    it('forwards Range header to Twilio and propagates 206 + Content-Range', async () => {
      const ctrl = makeCtrl({ integrations: [validIntegration], tenants: [validTenant] });
      mockedAxios.get.mockResolvedValue(
        upstreamStream(206, {
          'content-range': 'bytes 0-1023/118909',
          'content-length': '1024',
          'accept-ranges': 'bytes',
        }),
      );
      const res = makeRes();
      await ctrl.streamRecording(
        REAL_URL,
        makeReq({
          integrationId: 'int_1',
          tenantId: 'tn_1',
          range: 'bytes=0-1023',
        }),
        res,
      );
      expect(res.__inspect().statusCode).toBe(206);
      expect(res.__inspect().headers['content-range']).toBe('bytes 0-1023/118909');
      expect(res.__inspect().headers['content-length']).toBe('1024');
      expect(res.__inspect().headers['accept-ranges']).toBe('bytes');
      const passedHeaders = mockedAxios.get.mock.calls[0][1]?.headers as Record<string, string>;
      expect(passedHeaders['Range']).toBe('bytes=0-1023');
    });

    it('does NOT fabricate Accept-Ranges when upstream omits it', async () => {
      const ctrl = makeCtrl({ integrations: [validIntegration], tenants: [validTenant] });
      mockedAxios.get.mockResolvedValue(
        upstreamStream(200, { 'content-length': '100' }),
      );
      const res = makeRes();
      await ctrl.streamRecording(
        REAL_URL,
        makeReq({ integrationId: 'int_1', tenantId: 'tn_1' }),
        res,
      );
      // Twilio Recordings currently reply Accept-Ranges: none (i.e. omit
      // the value); the proxy must NOT synthesize `bytes` when it isn't
      // there, per the spec's "do not fabricate" rule.
      expect(res.__inspect().headers['accept-ranges']).toBeUndefined();
    });

    it('propagates upstream 404 verbatim (no fabricated 500)', async () => {
      const ctrl = makeCtrl({ integrations: [validIntegration], tenants: [validTenant] });
      mockedAxios.get.mockResolvedValue(upstreamStream(404, { 'content-type': 'application/json' }));
      const res = makeRes();
      await ctrl.streamRecording(
        REAL_URL,
        makeReq({ integrationId: 'int_1', tenantId: 'tn_1' }),
        res,
      );
      expect(res.__inspect().statusCode).toBe(404);
    });
  });

  describe('privacy', () => {
    it('never surfaces the decrypted auth token in any response header', async () => {
      const ctrl = makeCtrl({ integrations: [validIntegration], tenants: [validTenant] });
      mockedAxios.get.mockResolvedValue(upstreamStream(200));
      const res = makeRes();
      await ctrl.streamRecording(
        REAL_URL,
        makeReq({ integrationId: 'int_1', tenantId: 'tn_1' }),
        res,
      );
      const setHeaders = Object.values(res.__inspect().headers).join(' ');
      expect(setHeaders).not.toContain('auth-token-secret');
    });
  });
});
