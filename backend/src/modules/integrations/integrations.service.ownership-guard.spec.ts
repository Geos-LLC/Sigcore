/**
 * Incident 2026-07-14 — Ownership guard on IntegrationsService.ensureIntegration
 *
 * A cross-tenant call to POST /v1/integrations/ensure previously overwrote
 * the shared workspace integration row's credentials without a check,
 * silently taking over another tenant's Twilio account. This suite locks
 * in the guard semantics.
 *
 * Test names (see incident-2026-07-14 notes):
 *   - ensure_rejects_cross_tenant_rotation_with_creds
 *   - ensure_rejects_cross_tenant_probe_leak
 *   - ensure_rejects_rotation_on_legacy_row_without_allowLegacyClaim
 *   - ensure_allows_legacy_claim_with_flag_by_workspace_admin
 *   - ensure_same_tenant_rotation_still_works
 */

import { ConflictException, ForbiddenException } from '@nestjs/common';
import { IntegrationsService } from './integrations.service';
import { ProviderType } from '../../database/entities/communication-integration.entity';

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

function buildService() {
  const integrationRepo = buildMockRepo();
  const tenantIntegrationRepo = buildMockRepo();
  const tenantRepo = buildMockRepo();
  const workspaceRepo = buildMockRepo();
  const contactIdentityRepo = buildMockRepo();
  const snapshotRepo = buildMockRepo();
  const participantRepo = buildMockRepo();
  const openPhoneContactCache = {} as any;
  const encryptionService = {
    encrypt: jest.fn((v: string) => `enc(${v})`),
    decrypt: jest.fn((v: string) =>
      v.replace(/^enc\(/, '').replace(/\)$/, ''),
    ),
  };
  const openPhoneProvider = {} as any;
  const twilioProvider = {} as any;
  const twilioVoiceService = {} as any;
  const configService = { get: jest.fn() } as any;

  workspaceRepo.findOne.mockResolvedValue({
    id: 'ws-1',
    name: 'W1',
    webhookId: 'wh',
  });

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
const OWNER_TENANT = 'tenant-owner';
const OTHER_TENANT = 'tenant-attacker';
const INTEGRATION_ID = 'integration-abc-123';

describe('IntegrationsService.ensureIntegration — ownership guard (incident 2026-07-14)', () => {
  it('ensure_rejects_cross_tenant_rotation_with_creds', async () => {
    // Row is owned by tenant-owner. tenant-attacker attempts to rotate
    // credentials → must throw ConflictException, no save call.
    const { service, integrationRepo, tenantRepo, encryptionService } = buildService();
    tenantRepo.findOne.mockResolvedValue({ id: OTHER_TENANT, workspaceId: WS });
    integrationRepo.findOne.mockResolvedValue({
      id: INTEGRATION_ID,
      workspaceId: WS,
      provider: ProviderType.TWILIO,
      credentialsEncrypted: 'enc({})',
      metadata: { ensure: { tenantId: OWNER_TENANT } },
    });

    let thrown: any;
    try {
      await service.ensureIntegration(WS, {
        tenantId: OTHER_TENANT,
        provider: ProviderType.TWILIO,
        // NOTE: fixture placeholders only — never real credentials.
        credentials: { accountSid: 'AC_placeholder', authToken: 'placeholder' },
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(ConflictException);
    const body = thrown.getResponse();
    expect(body).toMatchObject({
      error: 'IntegrationOwnershipConflict',
      existingTenantId: OWNER_TENANT,
      requestedTenantId: OTHER_TENANT,
      integrationId: INTEGRATION_ID,
      workspaceId: WS,
      provider: ProviderType.TWILIO,
    });
    expect(integrationRepo.save).not.toHaveBeenCalled();
    expect(encryptionService.encrypt).not.toHaveBeenCalled();
  });

  it('ensure_rejects_cross_tenant_probe_leak', async () => {
    // Cross-tenant probe (no creds) must return 403 and must NOT leak
    // the integrationId in the body — that would let an attacker
    // enumerate owned rows.
    const { service, integrationRepo, tenantRepo } = buildService();
    tenantRepo.findOne.mockResolvedValue({ id: OTHER_TENANT, workspaceId: WS });
    integrationRepo.findOne.mockResolvedValue({
      id: INTEGRATION_ID,
      workspaceId: WS,
      provider: ProviderType.TWILIO,
      credentialsEncrypted: 'enc({})',
      metadata: { ensure: { tenantId: OWNER_TENANT } },
    });

    let thrown: any;
    try {
      await service.ensureIntegration(WS, {
        tenantId: OTHER_TENANT,
        provider: ProviderType.TWILIO,
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(ForbiddenException);
    const body = thrown.getResponse();
    expect(body).toMatchObject({
      error: 'IntegrationAccessDenied',
      existingTenantId: OWNER_TENANT,
      requestedTenantId: OTHER_TENANT,
      workspaceId: WS,
      provider: ProviderType.TWILIO,
    });
    // Critical: probe must NOT leak integrationId.
    expect((body as Record<string, unknown>).integrationId).toBeUndefined();
    expect(integrationRepo.save).not.toHaveBeenCalled();
  });

  it('ensure_rejects_rotation_on_legacy_row_without_allowLegacyClaim', async () => {
    // Legacy row = no metadata.ensure.tenantId. Rotating without opt-in
    // must throw 409 with reason=legacy_row_frozen_without_allowLegacyClaim
    // and NOT save.
    const { service, integrationRepo, tenantRepo, encryptionService } = buildService();
    tenantRepo.findOne.mockResolvedValue({ id: OTHER_TENANT, workspaceId: WS });
    integrationRepo.findOne.mockResolvedValue({
      id: INTEGRATION_ID,
      workspaceId: WS,
      provider: ProviderType.TWILIO,
      credentialsEncrypted: 'enc({})',
      metadata: {}, // no ensure block → legacy
    });

    let thrown: any;
    try {
      await service.ensureIntegration(WS, {
        tenantId: OTHER_TENANT,
        provider: ProviderType.TWILIO,
        credentials: { accountSid: 'AC_placeholder', authToken: 'placeholder' },
      });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(ConflictException);
    const body = thrown.getResponse();
    expect(body).toMatchObject({
      error: 'IntegrationOwnershipConflict',
      reason: 'legacy_row_frozen_without_allowLegacyClaim',
      existingTenantId: null,
      requestedTenantId: OTHER_TENANT,
      integrationId: INTEGRATION_ID,
      workspaceId: WS,
      provider: ProviderType.TWILIO,
    });
    expect(integrationRepo.save).not.toHaveBeenCalled();
    expect(encryptionService.encrypt).not.toHaveBeenCalled();
  });

  it('ensure_allows_legacy_claim_with_flag_by_workspace_admin', async () => {
    // Legacy row + allowLegacyClaim=true → rotation allowed. Save called
    // once. metadata.ensure.tenantId stamped. claimedFromLegacyAt stamped.
    const { service, integrationRepo, tenantRepo } = buildService();
    tenantRepo.findOne.mockResolvedValue({ id: OTHER_TENANT, workspaceId: WS });
    integrationRepo.findOne.mockResolvedValue({
      id: INTEGRATION_ID,
      workspaceId: WS,
      provider: ProviderType.TWILIO,
      credentialsEncrypted: 'enc({})',
      metadata: {}, // legacy
    });

    const result = await service.ensureIntegration(WS, {
      tenantId: OTHER_TENANT,
      provider: ProviderType.TWILIO,
      credentials: { accountSid: 'AC_placeholder', authToken: 'placeholder' },
      allowLegacyClaim: true,
    });

    expect(result.created).toBe(false);
    expect(integrationRepo.save).toHaveBeenCalledTimes(1);
    const saved = (integrationRepo.save as jest.Mock).mock.calls[0][0];
    expect(saved.metadata.ensure.tenantId).toBe(OTHER_TENANT);
    expect(saved.metadata.ensure.claimedFromLegacyAt).toBeDefined();
    expect(typeof saved.metadata.ensure.claimedFromLegacyAt).toBe('string');
    expect(saved.metadata.ensure.lastRotatedAt).toBeDefined();
  });

  it('ensure_same_tenant_rotation_still_works', async () => {
    // Regression protection: same tenant rotating their own row must
    // still succeed exactly as before. Guard must be transparent.
    const { service, integrationRepo, tenantRepo } = buildService();
    tenantRepo.findOne.mockResolvedValue({ id: OWNER_TENANT, workspaceId: WS });
    integrationRepo.findOne.mockResolvedValue({
      id: INTEGRATION_ID,
      workspaceId: WS,
      provider: ProviderType.TWILIO,
      credentialsEncrypted: 'enc({})',
      metadata: { ensure: { tenantId: OWNER_TENANT } },
    });

    const result = await service.ensureIntegration(WS, {
      tenantId: OWNER_TENANT,
      provider: ProviderType.TWILIO,
      credentials: { accountSid: 'AC_placeholder', authToken: 'placeholder' },
    });

    expect(result.created).toBe(false);
    expect(result.id).toBe(INTEGRATION_ID);
    expect(integrationRepo.save).toHaveBeenCalledTimes(1);
    const saved = (integrationRepo.save as jest.Mock).mock.calls[0][0];
    expect(saved.metadata.ensure.tenantId).toBe(OWNER_TENANT);
    expect(saved.metadata.ensure.lastRotatedAt).toBeDefined();
    // No legacy claim stamp on non-legacy rows.
    expect(saved.metadata.ensure.claimedFromLegacyAt).toBeUndefined();
  });
});
