import { BadRequestException } from '@nestjs/common';
import { TenantsV1Controller } from './tenants.controller';
import { TenantStatus } from '../../database/entities';

// Controller-level PR 2 tests: exercise the exact request → response path
// including URL validation, clear-via-null, clear-via-omitted-field, and
// dev/test-mode localhost handling.
//
// We construct the controller directly (no HTTP layer) — enough to observe
// the validator, the dev/test NODE_ENV switch, the assertCanAccessTenant
// short-circuit, and the response body shape.

function makeController(overrides: {
  tenant?: any;
  callerTenantId?: string | null;
  nodeEnv?: string;
} = {}) {
  const tenant = overrides.tenant ?? {
    id: 'tenant-1',
    workspaceId: 'ws-1',
    status: TenantStatus.ACTIVE,
    voiceInboundUrl: null,
  };
  const tenantsService = {
    setVoiceInboundUrl: jest.fn(async (_ws, _t, _c, url) => ({
      ...tenant,
      voiceInboundUrl: url,
    })),
    getVoiceInboundConfig: jest.fn(async () => ({
      voiceInboundUrl: tenant.voiceInboundUrl,
      configured: !!tenant.voiceInboundUrl,
    })),
  };
  const provisioningService = {} as any;
  const configService = {
    get: jest.fn(
      <T,>(k: string): T | undefined =>
        k === 'NODE_ENV'
          ? (overrides.nodeEnv ?? 'production') as unknown as T
          : undefined,
    ),
  };
  const ctrl = new TenantsV1Controller(
    tenantsService as any,
    provisioningService,
    configService as any,
  );
  return { ctrl, tenantsService };
}

const WS = 'ws-1';
const T = 'tenant-1';

describe('TenantsV1Controller.setVoiceWebhook (PUT)', () => {
  it('production rejects http:// scheme with 400', async () => {
    const { ctrl } = makeController({ nodeEnv: 'production' });
    await expect(
      ctrl.setVoiceWebhook(WS, null, T, { voiceInboundUrl: 'http://x' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('production rejects ftp/ws/wss/file/javascript scheme', async () => {
    const { ctrl } = makeController({ nodeEnv: 'production' });
    for (const url of [
      'ftp://example.com/x',
      'ws://example.com/x',
      'wss://example.com/x',
      'file:///etc/passwd',
      'javascript:alert(1)',
    ]) {
      await expect(
        ctrl.setVoiceWebhook(WS, null, T, { voiceInboundUrl: url }),
      ).rejects.toThrow(BadRequestException);
    }
  });

  it('production accepts https:// URL', async () => {
    const { ctrl, tenantsService } = makeController({ nodeEnv: 'production' });
    const res = await ctrl.setVoiceWebhook(WS, null, T, {
      voiceInboundUrl: 'https://example.com/twilio/inbound',
    });
    expect(res).toEqual({
      data: {
        voiceInboundUrl: 'https://example.com/twilio/inbound',
        configured: true,
      },
    });
    expect(tenantsService.setVoiceInboundUrl).toHaveBeenCalledWith(
      WS,
      T,
      null,
      'https://example.com/twilio/inbound',
    );
  });

  it('development accepts http://localhost', async () => {
    const { ctrl, tenantsService } = makeController({
      nodeEnv: 'development',
    });
    const res = await ctrl.setVoiceWebhook(WS, null, T, {
      voiceInboundUrl: 'http://localhost:3000/x',
    });
    expect(res.data.configured).toBe(true);
    expect(tenantsService.setVoiceInboundUrl).toHaveBeenCalledWith(
      WS,
      T,
      null,
      'http://localhost:3000/x',
    );
  });

  it('test env accepts http://127.0.0.1', async () => {
    const { ctrl } = makeController({ nodeEnv: 'test' });
    const res = await ctrl.setVoiceWebhook(WS, null, T, {
      voiceInboundUrl: 'http://127.0.0.1/x',
    });
    expect(res.data.configured).toBe(true);
  });

  it('production rejects http:// to non-localhost even in dev/test mode? no — but strict mode should always reject non-localhost http', async () => {
    const { ctrl } = makeController({ nodeEnv: 'development' });
    await expect(
      ctrl.setVoiceWebhook(WS, null, T, { voiceInboundUrl: 'http://example.com' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects empty string with 400 (use null to clear)', async () => {
    const { ctrl } = makeController({ nodeEnv: 'production' });
    await expect(
      ctrl.setVoiceWebhook(WS, null, T, { voiceInboundUrl: '' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects malformed URL', async () => {
    const { ctrl } = makeController({ nodeEnv: 'production' });
    await expect(
      ctrl.setVoiceWebhook(WS, null, T, { voiceInboundUrl: 'not a url' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('null clears the value', async () => {
    const { ctrl, tenantsService } = makeController({ nodeEnv: 'production' });
    const res = await ctrl.setVoiceWebhook(WS, null, T, {
      voiceInboundUrl: null,
    });
    expect(res.data).toEqual({ voiceInboundUrl: null, configured: false });
    expect(tenantsService.setVoiceInboundUrl).toHaveBeenCalledWith(
      WS,
      T,
      null,
      null,
    );
  });

  it('omitted voiceInboundUrl field clears the value', async () => {
    const { ctrl, tenantsService } = makeController({ nodeEnv: 'production' });
    const res = await ctrl.setVoiceWebhook(WS, null, T, {} as any);
    expect(res.data).toEqual({ voiceInboundUrl: null, configured: false });
    expect(tenantsService.setVoiceInboundUrl).toHaveBeenCalledWith(
      WS,
      T,
      null,
      null,
    );
  });

  it('caller tenant scope enforced — cross-tenant caller rejected before service call', async () => {
    const { ctrl } = makeController();
    await expect(
      ctrl.setVoiceWebhook(WS, 'other-tenant', T, {
        voiceInboundUrl: 'https://x',
      }),
    ).rejects.toThrow(/tenant scope|forbidden|access/i);
  });
});

describe('TenantsV1Controller.getVoiceWebhook (GET)', () => {
  it('returns unconfigured shape when null', async () => {
    const { ctrl } = makeController();
    const res = await ctrl.getVoiceWebhook(WS, null, T);
    expect(res).toEqual({
      data: { voiceInboundUrl: null, configured: false },
    });
  });

  it('returns configured shape when set', async () => {
    const { ctrl } = makeController({
      tenant: {
        id: T,
        workspaceId: WS,
        status: TenantStatus.ACTIVE,
        voiceInboundUrl: 'https://x',
      },
    });
    const res = await ctrl.getVoiceWebhook(WS, null, T);
    expect(res.data).toEqual({
      voiceInboundUrl: 'https://x',
      configured: true,
    });
  });

  it('caller tenant scope enforced — cross-tenant read rejected', async () => {
    const { ctrl } = makeController();
    await expect(
      ctrl.getVoiceWebhook(WS, 'other-tenant', T),
    ).rejects.toThrow(/tenant scope|forbidden|access/i);
  });
});
