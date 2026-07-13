/**
 * Guard for `TenantsService.deleteTenant`: TPNs owned by the tenant being
 * deleted but referenced by active PPAs from OTHER tenants (the PR15
 * shared-sender pattern) must be reparented to a same-workspace active
 * referencing tenant before the tenant is removed. Otherwise the FK
 * cascade wipes the load-bearing PPAs and every affected tenant's
 * outbound send starts returning 422 INVALID_PROFILE_PHONE.
 *
 * See 2026-07-13 Spotless incident.
 */
import { ConflictException } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { TenantStatus } from '../../database/entities';

const WS = 'ws-1';
const TENANT_TO_DELETE = 't-owner-inactive';
const OTHER_ACTIVE_TENANT = 't-alt-active';
const TPN_SHARED = 'tpn-shared';

function makeMockRepo() {
  const manager = {
    query: jest.fn(),
    getRepository: jest.fn(),
  };
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
    remove: jest.fn().mockResolvedValue(undefined),
    manager,
  };
}

function newService() {
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

describe('TenantsService.deleteTenant — shared-sender guard', () => {
  it('no shared TPNs → deletes without touching phones', async () => {
    const { service, tenantRepo } = newService();
    tenantRepo.findOne.mockResolvedValue({
      id: TENANT_TO_DELETE,
      workspaceId: WS,
      status: TenantStatus.INACTIVE,
    });
    // First query: load-bearing check returns empty
    tenantRepo.manager.query.mockResolvedValueOnce([]);

    await service.deleteTenant(WS, TENANT_TO_DELETE);

    expect(tenantRepo.remove).toHaveBeenCalledTimes(1);
    // No second query — no reparent path
    expect(tenantRepo.manager.query).toHaveBeenCalledTimes(1);
  });

  it('shared TPN with a same-workspace active referencing tenant → reparent then delete', async () => {
    const { service, tenantRepo } = newService();
    tenantRepo.findOne.mockResolvedValue({
      id: TENANT_TO_DELETE,
      workspaceId: WS,
      status: TenantStatus.INACTIVE,
    });
    tenantRepo.manager.query
      // load-bearing check
      .mockResolvedValueOnce([{ tpn_id: TPN_SHARED, phone_number: '+15551234567' }])
      // pick new owner
      .mockResolvedValueOnce([{ tenant_id: OTHER_ACTIVE_TENANT }])
      // update TPN
      .mockResolvedValueOnce(undefined);

    await service.deleteTenant(WS, TENANT_TO_DELETE);

    expect(tenantRepo.manager.query).toHaveBeenCalledTimes(3);
    // The third call should be the reparent UPDATE
    const updateCall = tenantRepo.manager.query.mock.calls[2];
    expect(updateCall[0]).toMatch(/UPDATE tenant_phone_numbers SET tenant_id/);
    expect(updateCall[1]).toEqual([OTHER_ACTIVE_TENANT, TPN_SHARED]);
    expect(tenantRepo.remove).toHaveBeenCalledTimes(1);
  });

  it('shared TPN with NO active referencing tenant → throws Conflict, does not delete', async () => {
    const { service, tenantRepo } = newService();
    tenantRepo.findOne.mockResolvedValue({
      id: TENANT_TO_DELETE,
      workspaceId: WS,
      status: TenantStatus.INACTIVE,
    });
    tenantRepo.manager.query
      .mockResolvedValueOnce([{ tpn_id: TPN_SHARED, phone_number: '+15551234567' }])
      // no candidate for reparent
      .mockResolvedValueOnce([]);

    await expect(service.deleteTenant(WS, TENANT_TO_DELETE)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tenantRepo.remove).not.toHaveBeenCalled();
  });

  it('multiple shared TPNs → all reparented, then delete once', async () => {
    const { service, tenantRepo } = newService();
    tenantRepo.findOne.mockResolvedValue({
      id: TENANT_TO_DELETE,
      workspaceId: WS,
      status: TenantStatus.INACTIVE,
    });
    tenantRepo.manager.query
      // load-bearing check returns 2 TPNs
      .mockResolvedValueOnce([
        { tpn_id: 'tpn-a', phone_number: '+15550001' },
        { tpn_id: 'tpn-b', phone_number: '+15550002' },
      ])
      // pick + update for tpn-a
      .mockResolvedValueOnce([{ tenant_id: OTHER_ACTIVE_TENANT }])
      .mockResolvedValueOnce(undefined)
      // pick + update for tpn-b
      .mockResolvedValueOnce([{ tenant_id: OTHER_ACTIVE_TENANT }])
      .mockResolvedValueOnce(undefined);

    await service.deleteTenant(WS, TENANT_TO_DELETE);

    expect(tenantRepo.manager.query).toHaveBeenCalledTimes(5);
    expect(tenantRepo.remove).toHaveBeenCalledTimes(1);
  });
});
