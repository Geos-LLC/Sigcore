/**
 * Wave-2 Task 1 — IntegrationsService.ensureIntegration
 *
 * Runbook test names (§Task 1 → Tests):
 *   - ensure_creates_new_when_absent
 *   - ensure_returns_existing_no_dup
 *   - ensure_rotates_credentials_when_supplied
 *   - ensure_returns_existing_when_credentials_absent
 *   - ensure_rejects_when_tenant_not_in_workspace
 *   - ensure_concurrent_calls_race_produces_one_row
 */

import { NotFoundException, BadRequestException } from '@nestjs/common';
import { IntegrationsService } from './integrations.service';
import { ProviderType, IntegrationStatus } from '../../database/entities/communication-integration.entity';

function buildMockRepo() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((data: any) => ({ ...data })),
    save: jest.fn(async (entity: any) => ({ id: entity.id ?? 'new-id', ...entity })),
    remove: jest.fn(),
    update: jest.fn(),
  };
}

function buildService(overrides: {
  encrypt?: jest.Mock;
  decrypt?: jest.Mock;
} = {}) {
  const integrationRepo = buildMockRepo();
  const tenantIntegrationRepo = buildMockRepo();
  const tenantRepo = buildMockRepo();
  const workspaceRepo = buildMockRepo();
  const contactIdentityRepo = buildMockRepo();
  const snapshotRepo = buildMockRepo();
  const participantRepo = buildMockRepo();
  const openPhoneContactCache = {} as any;
  const encryptionService = {
    encrypt: overrides.encrypt ?? jest.fn((v: string) => `enc(${v})`),
    decrypt: overrides.decrypt ?? jest.fn((v: string) => v.replace(/^enc\(/, '').replace(/\)$/, '')),
  };
  const openPhoneProvider = {} as any;
  const twilioProvider = {} as any;
  const twilioVoiceService = {} as any;
  const configService = { get: jest.fn() } as any;

  workspaceRepo.findOne.mockResolvedValue({ id: 'ws-1', name: 'W1', webhookId: 'wh' });

  const service = new IntegrationsService(
    integrationRepo as any,
    tenantIntegrationRepo as any,
    tenantRepo as any,
    workspaceRepo as any,
    contactIdentityRepo as any,
    snapshotRepo as any,
    participantRepo as any,
    openPhoneContactCache as any,
    encryptionService as any,
    openPhoneProvider as any,
    twilioProvider as any,
    twilioVoiceService as any,
    configService as any,
  );

  return {
    service,
    integrationRepo,
    tenantRepo,
    workspaceRepo,
    encryptionService,
  };
}

const WS = 'ws-1';
const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';

describe('IntegrationsService.ensureIntegration', () => {
  it('ensure_creates_new_when_absent', async () => {
    const { service, integrationRepo, tenantRepo } = buildService();
    tenantRepo.findOne.mockResolvedValue({ id: TENANT, workspaceId: WS });
    integrationRepo.findOne.mockResolvedValue(null);

    const result = await service.ensureIntegration(WS, {
      tenantId: TENANT,
      provider: ProviderType.TWILIO,
      credentials: { accountSid: 'AC1', authToken: 't' },
    });

    expect(result.created).toBe(true);
    expect(result.workspaceId).toBe(WS);
    expect(result.tenantId).toBe(TENANT);
    expect(result.provider).toBe(ProviderType.TWILIO);
    expect(integrationRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WS,
      provider: ProviderType.TWILIO,
      status: IntegrationStatus.ACTIVE,
    }));
    expect(integrationRepo.save).toHaveBeenCalledTimes(1);
  });

  it('ensure_returns_existing_no_dup', async () => {
    const { service, integrationRepo, tenantRepo } = buildService();
    tenantRepo.findOne.mockResolvedValue({ id: TENANT, workspaceId: WS });
    integrationRepo.findOne.mockResolvedValue({
      id: 'existing-id',
      workspaceId: WS,
      provider: ProviderType.TWILIO,
      credentialsEncrypted: 'enc({})',
      metadata: { ensure: { tenantId: TENANT } },
    });

    const result = await service.ensureIntegration(WS, {
      tenantId: TENANT,
      provider: ProviderType.TWILIO,
    });

    expect(result.created).toBe(false);
    expect(result.id).toBe('existing-id');
    expect(integrationRepo.create).not.toHaveBeenCalled();
    expect(integrationRepo.save).not.toHaveBeenCalled();
  });

  it('ensure_rotates_credentials_when_supplied', async () => {
    const encrypt = jest.fn((v: string) => `enc(${v})`);
    const decrypt = jest.fn(() => JSON.stringify({ accountSid: 'AC_OLD', authToken: 'old' }));
    const { service, integrationRepo, tenantRepo } = buildService({ encrypt, decrypt });
    tenantRepo.findOne.mockResolvedValue({ id: TENANT, workspaceId: WS });
    integrationRepo.findOne.mockResolvedValue({
      id: 'existing-id',
      workspaceId: WS,
      provider: ProviderType.TWILIO,
      credentialsEncrypted: 'enc(...)',
      metadata: { ensure: { tenantId: TENANT } },
    });

    const result = await service.ensureIntegration(WS, {
      tenantId: TENANT,
      provider: ProviderType.TWILIO,
      credentials: { accountSid: 'AC_NEW' },
    });

    expect(result.created).toBe(false);
    expect(integrationRepo.save).toHaveBeenCalledTimes(1);
    const saved = (integrationRepo.save as jest.Mock).mock.calls[0][0];
    // encrypt was called with the merged JSON — accountSid should be the new value
    const encArg = (encrypt as jest.Mock).mock.calls.pop()![0] as string;
    expect(encArg).toContain('AC_NEW');
    expect(encArg).toContain('old'); // authToken preserved
    expect(saved.metadata.ensure.lastRotatedAt).toBeDefined();
  });

  it('ensure_returns_existing_when_credentials_absent', async () => {
    const { service, integrationRepo, tenantRepo, encryptionService } = buildService();
    tenantRepo.findOne.mockResolvedValue({ id: TENANT, workspaceId: WS });
    integrationRepo.findOne.mockResolvedValue({
      id: 'existing-id',
      workspaceId: WS,
      provider: ProviderType.TWILIO,
      credentialsEncrypted: 'enc({})',
      metadata: {},
    });

    const result = await service.ensureIntegration(WS, {
      tenantId: TENANT,
      provider: ProviderType.TWILIO,
    });

    expect(result.created).toBe(false);
    expect(encryptionService.encrypt).not.toHaveBeenCalled();
    expect(integrationRepo.save).not.toHaveBeenCalled();
  });

  it('ensure_probe_returns_404_when_no_credentials_and_no_existing_row', async () => {
    // Wave-2 Task 2 transition contract refinement (2026-07-11):
    // ensure without credentials is probe-mode. If no row exists, it must
    // NotFound instead of creating an empty-credentials row.
    const { service, integrationRepo, tenantRepo, encryptionService } = buildService();
    tenantRepo.findOne.mockResolvedValue({ id: TENANT, workspaceId: WS });
    integrationRepo.findOne.mockResolvedValue(null);

    await expect(
      service.ensureIntegration(WS, {
        tenantId: TENANT,
        provider: ProviderType.TWILIO,
      }),
    ).rejects.toThrow(/probe returned nothing/);

    expect(integrationRepo.create).not.toHaveBeenCalled();
    expect(integrationRepo.save).not.toHaveBeenCalled();
    expect(encryptionService.encrypt).not.toHaveBeenCalled();
  });

  it('ensure_probe_returns_404_when_credentials_is_empty_object', async () => {
    const { service, integrationRepo, tenantRepo } = buildService();
    tenantRepo.findOne.mockResolvedValue({ id: TENANT, workspaceId: WS });
    integrationRepo.findOne.mockResolvedValue(null);

    await expect(
      service.ensureIntegration(WS, {
        tenantId: TENANT,
        provider: ProviderType.TWILIO,
        credentials: {},
      }),
    ).rejects.toThrow(/probe returned nothing/);

    expect(integrationRepo.create).not.toHaveBeenCalled();
  });

  it('ensure_rejects_when_tenant_not_in_workspace', async () => {
    const { service, tenantRepo } = buildService();
    tenantRepo.findOne.mockResolvedValue(null);

    await expect(
      service.ensureIntegration(WS, {
        tenantId: OTHER_TENANT,
        provider: ProviderType.TWILIO,
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('ensure_concurrent_calls_race_produces_one_row', async () => {
    // Simulate: race — first findOne returns null (no row yet), save throws
    // 23505 unique-violation, second findOne returns the row inserted by the
    // racing caller. Expected result: created:false, id of the winner.
    const { service, integrationRepo, tenantRepo } = buildService();
    tenantRepo.findOne.mockResolvedValue({ id: TENANT, workspaceId: WS });
    integrationRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'winner-id',
        workspaceId: WS,
        provider: ProviderType.TWILIO,
        credentialsEncrypted: 'enc({})',
        metadata: {},
      });
    integrationRepo.save.mockRejectedValueOnce(Object.assign(new Error('unique_violation'), { code: '23505' }));

    const result = await service.ensureIntegration(WS, {
      tenantId: TENANT,
      provider: ProviderType.TWILIO,
      credentials: { accountSid: 'AC_R' },
    });

    expect(result.created).toBe(false);
    expect(result.id).toBe('winner-id');
  });

  it('rejects when provider missing (BadRequest)', async () => {
    const { service } = buildService();
    await expect(
      service.ensureIntegration(WS, { tenantId: TENANT } as any),
    ).rejects.toThrow(BadRequestException);
  });
});
