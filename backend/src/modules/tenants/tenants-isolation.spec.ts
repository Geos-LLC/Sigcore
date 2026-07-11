/**
 * Tenant-scope isolation tests for TenantsService and
 * PhoneNumberProvisioningService.
 *
 * These are service-level tests using mock repos (same pattern as
 * tenants.service.provision.spec.ts). They lock down the fix for the Callio
 * "shared workspace 1bcbb4e0…" leak: a tenant-scoped caller must NOT be able to
 * see or mutate another tenant's records that happen to live in the same
 * workspace.
 *
 * Coverage matrix (per PLATFORM_API_MODEL.md §2 "scoping via auth"):
 *   - getTenants:  workspace-scoped → full list; tenant-scoped → [self] only
 *   - getTenant:   workspace-scoped → any id; tenant-scoped → own id, else 403
 *   - createTenant: raw create refuses anchor names/external_ids
 *   - getWorkspaceOrderHistory: workspace-scoped → all; tenant-scoped → filtered
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { PhoneNumberProvisioningService } from './phone-number-provisioning.service';

function makeMockRepo() {
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
    remove: jest.fn(),
    manager: { getRepository: jest.fn(() => ({ find: jest.fn().mockResolvedValue([]) })) },
  };
}

const WS = 'ws-shared-master';
const SELF = 't-caller';
const OTHER = 't-other';

function newTenantsService() {
  const tenantRepo = makeMockRepo();
  const service = new TenantsService(
    tenantRepo as any,
    makeMockRepo() as any,
    makeMockRepo() as any,
    makeMockRepo() as any,
    {} as any,
    {} as any,
  );
  return { service, tenantRepo };
}

function newProvisioningService() {
  const orderRepo = makeMockRepo();
  const service = new PhoneNumberProvisioningService(
    orderRepo as any,
    makeMockRepo() as any,
    makeMockRepo() as any,
    makeMockRepo() as any,
    makeMockRepo() as any,
    makeMockRepo() as any,
    makeMockRepo() as any,
    makeMockRepo() as any,
    makeMockRepo() as any,
    makeMockRepo() as any,
    makeMockRepo() as any,
    {} as any,
    {} as any,
    {} as any,
  );
  return { service, orderRepo };
}

describe('TenantsService.getTenants — scope isolation', () => {
  it('workspace-scoped caller: returns full workspace list', async () => {
    const { service, tenantRepo } = newTenantsService();
    tenantRepo.find.mockResolvedValue([
      { id: SELF, workspaceId: WS },
      { id: OTHER, workspaceId: WS },
    ]);

    const result = await service.getTenants(WS, { callerTenantId: null });
    expect(result).toHaveLength(2);
    expect(tenantRepo.find).toHaveBeenCalledWith({
      where: { workspaceId: WS },
      relations: ['phoneNumbers'],
      order: { createdAt: 'DESC' },
    });
  });

  it('tenant-scoped caller: returns [self] only, even when other tenants exist', async () => {
    const { service, tenantRepo } = newTenantsService();
    tenantRepo.find.mockResolvedValue([{ id: SELF, workspaceId: WS }]);

    const result = await service.getTenants(WS, { callerTenantId: SELF });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(SELF);
    // Query MUST include the tenant id filter, not just workspaceId.
    expect(tenantRepo.find).toHaveBeenCalledWith({
      where: { workspaceId: WS, id: SELF },
      relations: ['phoneNumbers'],
    });
  });

  it('tenant-scoped caller in a workspace they were never provisioned into: returns []', async () => {
    const { service, tenantRepo } = newTenantsService();
    tenantRepo.find.mockResolvedValue([]);
    const result = await service.getTenants(WS, { callerTenantId: 'stranger' });
    expect(result).toEqual([]);
  });

  it('undefined opts still works (back-compat with internal callers)', async () => {
    const { service, tenantRepo } = newTenantsService();
    tenantRepo.find.mockResolvedValue([{ id: SELF }]);
    await service.getTenants(WS);
    expect(tenantRepo.find).toHaveBeenCalledWith({
      where: { workspaceId: WS },
      relations: ['phoneNumbers'],
      order: { createdAt: 'DESC' },
    });
  });
});

describe('TenantsService.getTenant — scope isolation', () => {
  it('workspace-scoped caller: reads any tenant in workspace', async () => {
    const { service, tenantRepo } = newTenantsService();
    tenantRepo.findOne.mockResolvedValue({ id: OTHER, workspaceId: WS });

    const result = await service.getTenant(WS, OTHER, null);
    expect(result.id).toBe(OTHER);
  });

  it('tenant-scoped caller reading own tenant: succeeds', async () => {
    const { service, tenantRepo } = newTenantsService();
    tenantRepo.findOne.mockResolvedValue({ id: SELF, workspaceId: WS });

    const result = await service.getTenant(WS, SELF, SELF);
    expect(result.id).toBe(SELF);
  });

  it('tenant-scoped caller reading OTHER tenant: throws ForbiddenException', async () => {
    const { service, tenantRepo } = newTenantsService();

    await expect(service.getTenant(WS, OTHER, SELF)).rejects.toThrow(
      ForbiddenException,
    );
    // Must reject BEFORE hitting the DB — no read attempt should be issued.
    expect(tenantRepo.findOne).not.toHaveBeenCalled();
  });

  it('callerTenantId undefined = no scope check (internal caller path)', async () => {
    const { service, tenantRepo } = newTenantsService();
    tenantRepo.findOne.mockResolvedValue({ id: OTHER, workspaceId: WS });

    // No third arg → old behavior; used by other internal services.
    await expect(service.getTenant(WS, OTHER)).resolves.toBeTruthy();
  });
});

describe('TenantsService.createTenant — anchor gap closed on raw create', () => {
  it('rejects anchor displayName (Callio) even via raw POST /tenants', async () => {
    const { service } = newTenantsService();
    await expect(
      service.createTenant(WS, { name: 'Callio' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects anchor externalId (leadbridge-*) even via raw POST /tenants', async () => {
    const { service } = newTenantsService();
    await expect(
      service.createTenant(WS, {
        externalId: 'leadbridge-1234',
        name: 'Something Else',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('accepts a normal customer tenant', async () => {
    const { service, tenantRepo } = newTenantsService();
    tenantRepo.findOne.mockResolvedValue(null);
    tenantRepo.create.mockImplementation((d: any) => ({ id: 't-new', ...d }));
    tenantRepo.save.mockImplementation(async (t: any) => t);

    const t = await service.createTenant(WS, {
      externalId: 'lb-savedaccount-uuid',
      name: 'Spotless Homes Tampa',
    });
    expect(t.id).toBe('t-new');
  });
});

describe('PhoneNumberProvisioningService.getWorkspaceOrderHistory — scope isolation', () => {
  it('workspace-scoped caller: returns every order in the workspace', async () => {
    const { service, orderRepo } = newProvisioningService();
    orderRepo.find.mockResolvedValue([
      { id: 'o1', tenantId: SELF },
      { id: 'o2', tenantId: OTHER },
    ]);

    const result = await service.getWorkspaceOrderHistory(WS, null);
    expect(result).toHaveLength(2);
    expect(orderRepo.find).toHaveBeenCalledWith({
      where: { workspaceId: WS },
      order: { createdAt: 'DESC' },
      relations: ['tenant'],
    });
  });

  it('tenant-scoped caller: filters to caller tenantId', async () => {
    const { service, orderRepo } = newProvisioningService();
    orderRepo.find.mockResolvedValue([{ id: 'o1', tenantId: SELF }]);

    const result = await service.getWorkspaceOrderHistory(WS, SELF);
    expect(result).toHaveLength(1);
    // The query MUST have the tenantId filter; otherwise the leak returns.
    expect(orderRepo.find).toHaveBeenCalledWith({
      where: { workspaceId: WS, tenantId: SELF },
      order: { createdAt: 'DESC' },
      relations: ['tenant'],
    });
  });
});
