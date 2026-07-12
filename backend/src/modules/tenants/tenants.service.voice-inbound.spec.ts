import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { TenantStatus } from '../../database/entities';

// PR 2 — TenantsService.setVoiceInboundUrl + getVoiceInboundConfig.
// Covers authorization scoping, status enforcement, clear-vs-set semantics,
// and stale-value guarantee (null persistence).

function repo() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    save: jest.fn(async (x: any) => x),
    create: jest.fn(),
    remove: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
}

function buildService(overrides: any = {}) {
  const tenantRepo = repo();
  const tenantPhoneRepo = repo();
  const integrationRepo = repo();
  const tenantIntegrationRepo = repo();
  const encryptionService = { encrypt: jest.fn(), decrypt: jest.fn() };
  const providerRegistry = { getProvider: jest.fn() };

  const svc = new TenantsService(
    tenantRepo as any,
    tenantPhoneRepo as any,
    integrationRepo as any,
    tenantIntegrationRepo as any,
    encryptionService as any,
    providerRegistry as any,
  );

  return { svc, tenantRepo, ...overrides };
}

const WS = 'ws-1';
const T = 'tenant-1';

const activeTenant = () => ({
  id: T,
  workspaceId: WS,
  externalId: 'ext-1',
  name: 'Test',
  status: TenantStatus.ACTIVE,
  voiceInboundUrl: null,
});

describe('TenantsService.setVoiceInboundUrl', () => {
  it('cross-tenant access rejected (caller tenant scope)', async () => {
    const { svc, tenantRepo } = buildService();
    tenantRepo.findOne.mockResolvedValue(activeTenant());
    await expect(
      svc.setVoiceInboundUrl(WS, T, 'other-tenant', 'https://x'),
    ).rejects.toThrow(/tenant-scoped/i);
  });

  it('cross-workspace access rejected (findOne returns null)', async () => {
    const { svc, tenantRepo } = buildService();
    tenantRepo.findOne.mockResolvedValue(null);
    await expect(
      svc.setVoiceInboundUrl('other-ws', T, null, 'https://x'),
    ).rejects.toThrow(NotFoundException);
  });

  it('deleted tenant rejected — 404', async () => {
    const { svc, tenantRepo } = buildService();
    tenantRepo.findOne.mockResolvedValue(null);
    await expect(
      svc.setVoiceInboundUrl(WS, T, null, 'https://x'),
    ).rejects.toThrow(NotFoundException);
  });

  it('inactive tenant rejected — 403', async () => {
    const { svc, tenantRepo } = buildService();
    tenantRepo.findOne.mockResolvedValue({
      ...activeTenant(),
      status: TenantStatus.INACTIVE,
    });
    await expect(
      svc.setVoiceInboundUrl(WS, T, null, 'https://x'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('suspended tenant rejected — 403', async () => {
    const { svc, tenantRepo } = buildService();
    tenantRepo.findOne.mockResolvedValue({
      ...activeTenant(),
      status: TenantStatus.SUSPENDED,
    });
    await expect(
      svc.setVoiceInboundUrl(WS, T, null, 'https://x'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('sets a valid URL', async () => {
    const { svc, tenantRepo } = buildService();
    const t = activeTenant();
    tenantRepo.findOne.mockResolvedValue(t);
    const result = await svc.setVoiceInboundUrl(
      WS,
      T,
      null,
      'https://example.com/x',
    );
    expect(result.voiceInboundUrl).toBe('https://example.com/x');
    expect(tenantRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ voiceInboundUrl: 'https://example.com/x' }),
    );
  });

  it('null persists as null (no stale value)', async () => {
    const { svc, tenantRepo } = buildService();
    const t = {
      ...activeTenant(),
      voiceInboundUrl: 'https://previous-value.example',
    };
    tenantRepo.findOne.mockResolvedValue(t);
    const result = await svc.setVoiceInboundUrl(WS, T, null, null);
    expect(result.voiceInboundUrl).toBeNull();
    expect(tenantRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ voiceInboundUrl: null }),
    );
  });
});

describe('TenantsService.getVoiceInboundConfig', () => {
  it('returns configured: false when null', async () => {
    const { svc, tenantRepo } = buildService();
    tenantRepo.findOne.mockResolvedValue(activeTenant());
    const cfg = await svc.getVoiceInboundConfig(WS, T, null);
    expect(cfg).toEqual({ voiceInboundUrl: null, configured: false });
  });

  it('returns configured: true when set', async () => {
    const { svc, tenantRepo } = buildService();
    tenantRepo.findOne.mockResolvedValue({
      ...activeTenant(),
      voiceInboundUrl: 'https://x',
    });
    const cfg = await svc.getVoiceInboundConfig(WS, T, null);
    expect(cfg).toEqual({ voiceInboundUrl: 'https://x', configured: true });
  });

  it('cross-tenant read rejected', async () => {
    const { svc, tenantRepo } = buildService();
    tenantRepo.findOne.mockResolvedValue(activeTenant());
    await expect(
      svc.getVoiceInboundConfig(WS, T, 'other-tenant'),
    ).rejects.toThrow(/tenant-scoped/i);
  });

  it('cross-workspace read rejected — 404', async () => {
    const { svc, tenantRepo } = buildService();
    tenantRepo.findOne.mockResolvedValue(null);
    await expect(
      svc.getVoiceInboundConfig('other-ws', T, null),
    ).rejects.toThrow(NotFoundException);
  });
});
