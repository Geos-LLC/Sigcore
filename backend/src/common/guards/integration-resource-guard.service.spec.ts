/**
 * Wave-2 Task 3 — IntegrationResourceGuardService (4-way validator).
 *
 * Covers the four rejection modes named in the runbook plus happy paths for
 * both `providerCallSid` and `tpnId` variants. Each rejection mode asserts
 * that the thrown ForbiddenException carries the correct `check=N` marker.
 */

import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { IntegrationResourceGuardService } from './integration-resource-guard.service';
import { ProviderType } from '../../database/entities/communication-integration.entity';
import { PhoneNumberProvider } from '../../database/entities/tenant-phone-number.entity';

function buildMockRepo() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
  };
}

function build() {
  const tenantRepo = buildMockRepo();
  const integrationRepo = buildMockRepo();
  const callRepo = buildMockRepo();
  const tpnRepo = buildMockRepo();
  const svc = new IntegrationResourceGuardService(
    tenantRepo as any,
    integrationRepo as any,
    callRepo as any,
    tpnRepo as any,
  );
  return { svc, tenantRepo, integrationRepo, callRepo, tpnRepo };
}

const WS = 'ws-1';
const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';
const INT_ID = 'integration-1';
const CALL_SID = 'CA1234567890abcdef';
const TPN_ID = 'tpn-1';

const request = (overrides: Record<string, any> = {}) => ({
  workspaceId: WS,
  tenantId: TENANT,
  authType: 'service',
  authScopeType: 'workspace',
  body: { integrationId: INT_ID, tenantId: TENANT },
  ...overrides,
});

describe('IntegrationResourceGuardService.assert (providerCallSid variant)', () => {
  it('happy path — recording start succeeds', async () => {
    const { svc, tenantRepo, integrationRepo, callRepo } = build();
    tenantRepo.findOne.mockResolvedValue({ id: TENANT, workspaceId: WS });
    integrationRepo.findOne.mockResolvedValue({
      id: INT_ID,
      workspaceId: WS,
      provider: ProviderType.TWILIO,
      metadata: { ensure: { tenantId: TENANT } },
    });
    callRepo.findOne.mockResolvedValue({
      providerCallId: CALL_SID,
      metadata: { integrationId: INT_ID },
    });

    const result = await svc.assert({
      request: request(),
      integrationId: INT_ID,
      providerCallSid: CALL_SID,
    });

    expect(result.workspaceId).toBe(WS);
    expect(result.tenantId).toBe(TENANT);
    expect(result.integration.id).toBe(INT_ID);
  });

  it('rejects_when_workspace_does_not_own_tenant (check=1)', async () => {
    const { svc, tenantRepo } = build();
    tenantRepo.findOne.mockResolvedValue(null);

    await expect(
      svc.assert({
        request: request(),
        integrationId: INT_ID,
        providerCallSid: CALL_SID,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('check=1 failed'),
    });
  });

  it('rejects_when_api_key_tenant_scope_mismatches_body_tenant (check=2)', async () => {
    const { svc, tenantRepo } = build();
    tenantRepo.findOne.mockResolvedValue({ id: TENANT, workspaceId: WS });

    await expect(
      svc.assert({
        request: request({
          authType: 'api_key',
          authScopeType: 'tenant',
          tenantId: TENANT,
          body: { integrationId: INT_ID, tenantId: OTHER_TENANT },
        }),
        integrationId: INT_ID,
        providerCallSid: CALL_SID,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('check=2 failed'),
    });
  });

  it('rejects_when_integration_id_belongs_to_other_tenant (check=3)', async () => {
    const { svc, tenantRepo, integrationRepo } = build();
    tenantRepo.findOne.mockResolvedValue({ id: TENANT, workspaceId: WS });
    integrationRepo.findOne.mockResolvedValue({
      id: INT_ID,
      workspaceId: WS,
      provider: ProviderType.TWILIO,
      metadata: { ensure: { tenantId: OTHER_TENANT } },
    });

    await expect(
      svc.assert({
        request: request(),
        integrationId: INT_ID,
        providerCallSid: CALL_SID,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('check=3 failed'),
    });
  });

  it('rejects_when_provider_call_sid_not_linked_to_integration (check=4)', async () => {
    const { svc, tenantRepo, integrationRepo, callRepo } = build();
    tenantRepo.findOne.mockResolvedValue({ id: TENANT, workspaceId: WS });
    integrationRepo.findOne.mockResolvedValue({
      id: INT_ID,
      workspaceId: WS,
      provider: ProviderType.TWILIO,
      externalWorkspaceId: 'not-an-account-sid',
      metadata: { ensure: { tenantId: TENANT } },
    });
    callRepo.findOne.mockResolvedValue(null);

    await expect(
      svc.assert({
        request: request(),
        integrationId: INT_ID,
        providerCallSid: 'XX_not_twilio_sid',
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('check=4 failed'),
    });
  });

  it('pilot fallback: allows when call not persisted but SID matches AccountSid prefix', async () => {
    const { svc, tenantRepo, integrationRepo, callRepo } = build();
    tenantRepo.findOne.mockResolvedValue({ id: TENANT, workspaceId: WS });
    integrationRepo.findOne.mockResolvedValue({
      id: INT_ID,
      workspaceId: WS,
      provider: ProviderType.TWILIO,
      externalWorkspaceId: 'AC000abc',
      metadata: { ensure: { tenantId: TENANT } },
    });
    callRepo.findOne.mockResolvedValue(null);

    const result = await svc.assert({
      request: request(),
      integrationId: INT_ID,
      providerCallSid: CALL_SID, // starts with 'CA'
    });
    expect(result.integration.id).toBe(INT_ID);
  });
});

describe('IntegrationResourceGuardService.assert (tpnId variant)', () => {
  it('happy path — tpn belongs to (workspace, tenant) and provider matches', async () => {
    const { svc, tenantRepo, integrationRepo, tpnRepo } = build();
    tenantRepo.findOne.mockResolvedValue({ id: TENANT, workspaceId: WS });
    integrationRepo.findOne.mockResolvedValue({
      id: INT_ID,
      workspaceId: WS,
      provider: ProviderType.TWILIO,
      metadata: { ensure: { tenantId: TENANT } },
    });
    tpnRepo.findOne.mockResolvedValue({
      id: TPN_ID,
      workspaceId: WS,
      tenantId: TENANT,
      provider: PhoneNumberProvider.TWILIO,
    });

    const result = await svc.assert({
      request: request(),
      integrationId: INT_ID,
      tpnId: TPN_ID,
    });
    expect(result.integration.id).toBe(INT_ID);
  });

  it('rejects when tpn not found (check=4)', async () => {
    const { svc, tenantRepo, integrationRepo, tpnRepo } = build();
    tenantRepo.findOne.mockResolvedValue({ id: TENANT, workspaceId: WS });
    integrationRepo.findOne.mockResolvedValue({
      id: INT_ID,
      workspaceId: WS,
      provider: ProviderType.TWILIO,
      metadata: { ensure: { tenantId: TENANT } },
    });
    tpnRepo.findOne.mockResolvedValue(null);

    await expect(
      svc.assert({ request: request(), integrationId: INT_ID, tpnId: TPN_ID }),
    ).rejects.toMatchObject({ message: expect.stringContaining('check=4 failed') });
  });

  it('rejects when tpn provider does not match integration provider (check=4)', async () => {
    const { svc, tenantRepo, integrationRepo, tpnRepo } = build();
    tenantRepo.findOne.mockResolvedValue({ id: TENANT, workspaceId: WS });
    integrationRepo.findOne.mockResolvedValue({
      id: INT_ID,
      workspaceId: WS,
      provider: ProviderType.TWILIO,
      metadata: { ensure: { tenantId: TENANT } },
    });
    tpnRepo.findOne.mockResolvedValue({
      id: TPN_ID,
      workspaceId: WS,
      tenantId: TENANT,
      provider: PhoneNumberProvider.OPENPHONE,
    });

    await expect(
      svc.assert({ request: request(), integrationId: INT_ID, tpnId: TPN_ID }),
    ).rejects.toMatchObject({ message: expect.stringContaining('check=4 failed') });
  });
});

describe('IntegrationResourceGuardService.assert (input validation)', () => {
  it('rejects when integrationId missing (BadRequest)', async () => {
    const { svc } = build();
    await expect(
      svc.assert({ request: request(), integrationId: '' as any }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects when workspaceId missing on request (Forbidden)', async () => {
    const { svc } = build();
    await expect(
      svc.assert({
        request: request({ workspaceId: undefined }),
        integrationId: INT_ID,
      }),
    ).rejects.toThrow(ForbiddenException);
  });
});
