/**
 * Service-level test for the idempotent tenant provisioning path (PR10).
 *
 * Mocks the TypeORM repos. Verifies that:
 *   - same externalTenantId twice returns same tenant id (reused=true)
 *   - first call creates new (reused=false)
 *   - anchor inputs are rejected with BadRequestException
 *   - inactive tenants are NOT reused unless allowInactive=true
 *   - race condition (concurrent unique-index conflict) is recovered to a reuse
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { TenantStatus } from '../../database/entities';

function makeMockRepo() {
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
    manager: { getRepository: jest.fn(() => ({ find: jest.fn().mockResolvedValue([]) })) },
  };
}

const WS = 'ws-1';

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

describe('TenantsService.findOrCreateTenantByExternalId', () => {
  it('first call → creates new tenant, reused=false', async () => {
    const { service, tenantRepo } = newService();
    tenantRepo.find.mockResolvedValue([]);
    // After the unique check inside createTenant, tenant is created via .save
    tenantRepo.findOne.mockResolvedValue(null);
    tenantRepo.create.mockImplementation((data: any) => ({
      id: 't-new',
      ...data,
      createdAt: new Date(),
    }));
    tenantRepo.save.mockImplementation(async (t: any) => t);

    const out = await service.findOrCreateTenantByExternalId(WS, {
      externalTenantId: 'sa-uuid',
      displayName: 'Spotless Homes Tampa',
    });
    expect(out.reused).toBe(false);
    expect(out.tenant.id).toBe('t-new');
    expect(out.tenant.externalId).toBe('sa-uuid');
    expect(out.tenant.name).toBe('Spotless Homes Tampa');
  });

  it('second call with same externalTenantId → reuse, reused=true', async () => {
    const { service, tenantRepo } = newService();
    tenantRepo.find.mockResolvedValue([
      { id: 't-existing', externalId: 'sa-uuid', status: 'active', name: 'Spotless Homes Tampa' },
    ]);

    const out = await service.findOrCreateTenantByExternalId(WS, {
      externalTenantId: 'sa-uuid',
      displayName: 'Spotless Homes Tampa',
    });
    expect(out.reused).toBe(true);
    expect(out.tenant.id).toBe('t-existing');
    expect(tenantRepo.create).not.toHaveBeenCalled();
  });

  it('updates display name on reused tenant when changed', async () => {
    const { service, tenantRepo } = newService();
    const existing = {
      id: 't-existing',
      externalId: 'sa-uuid',
      status: 'active',
      name: 'Old Name',
    };
    tenantRepo.find.mockResolvedValue([existing]);
    tenantRepo.save.mockImplementation(async (t: any) => t);

    await service.findOrCreateTenantByExternalId(WS, {
      externalTenantId: 'sa-uuid',
      displayName: 'New Name',
    });
    expect(existing.name).toBe('New Name');
    expect(tenantRepo.save).toHaveBeenCalledWith(existing);
  });

  it('rejects anchor displayName before any DB call', async () => {
    const { service, tenantRepo } = newService();
    await expect(
      service.findOrCreateTenantByExternalId(WS, {
        externalTenantId: 'sa-uuid',
        displayName: 'LeadBridge',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tenantRepo.find).not.toHaveBeenCalled();
  });

  it('rejects anchor-prefixed externalTenantId before any DB call', async () => {
    const { service, tenantRepo } = newService();
    await expect(
      service.findOrCreateTenantByExternalId(WS, {
        externalTenantId: 'leadbridge-4xtm',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tenantRepo.find).not.toHaveBeenCalled();
  });

  it('refuses to reuse anchor tenant even if it somehow matched (defensive)', async () => {
    const { service, tenantRepo } = newService();
    tenantRepo.find.mockResolvedValue([
      { id: 't-anchor', externalId: 'sa-real', status: 'active', name: 'LeadBridge' },
    ]);
    await expect(
      service.findOrCreateTenantByExternalId(WS, {
        externalTenantId: 'sa-real',
        displayName: 'Real Customer',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects inactive tenant without allowInactive', async () => {
    const { service, tenantRepo } = newService();
    tenantRepo.find.mockResolvedValue([
      { id: 't-inactive', externalId: 'sa-uuid', status: 'inactive', name: 'X' },
    ]);
    await expect(
      service.findOrCreateTenantByExternalId(WS, { externalTenantId: 'sa-uuid' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('reuses inactive tenant when allowInactive=true', async () => {
    const { service, tenantRepo } = newService();
    tenantRepo.find.mockResolvedValue([
      { id: 't-inactive', externalId: 'sa-uuid', status: 'inactive', name: 'X' },
    ]);
    const out = await service.findOrCreateTenantByExternalId(WS, {
      externalTenantId: 'sa-uuid',
      allowInactive: true,
    });
    expect(out.reused).toBe(true);
    expect(out.tenant.id).toBe('t-inactive');
  });

  it('recovers from concurrent insert (unique index race) by re-looking-up', async () => {
    const { service, tenantRepo } = newService();
    // First find: empty (we're going to try to create)
    tenantRepo.find.mockResolvedValue([]);
    // The pre-check inside createTenant returns null — but the save throws ConflictException
    // because a parallel call won.
    tenantRepo.findOne
      .mockResolvedValueOnce(null) // inside createTenant's pre-check
      .mockResolvedValueOnce({
        // post-conflict re-lookup
        id: 't-winner',
        externalId: 'sa-uuid',
        status: 'active',
        name: 'X',
      });
    tenantRepo.create.mockImplementation((data: any) => ({
      id: 't-loser',
      ...data,
    }));
    tenantRepo.save.mockImplementationOnce(() => {
      throw new ConflictException('duplicate key');
    });

    const out = await service.findOrCreateTenantByExternalId(WS, {
      externalTenantId: 'sa-uuid',
      displayName: 'Customer',
    });
    expect(out.reused).toBe(true);
    expect(out.tenant.id).toBe('t-winner');
  });

  it('errors with missing externalTenantId', async () => {
    const { service } = newService();
    await expect(
      service.findOrCreateTenantByExternalId(WS, { externalTenantId: '' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.findOrCreateTenantByExternalId(WS, { externalTenantId: '   ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('TenantStatus.ACTIVE constant is honored on creation', async () => {
    const { service, tenantRepo } = newService();
    tenantRepo.find.mockResolvedValue([]);
    tenantRepo.findOne.mockResolvedValue(null);
    let createdInput: any = null;
    tenantRepo.create.mockImplementation((data: any) => {
      createdInput = data;
      return { id: 't-new', ...data };
    });
    tenantRepo.save.mockImplementation(async (t: any) => t);

    await service.findOrCreateTenantByExternalId(WS, {
      externalTenantId: 'sa-uuid',
    });
    expect(createdInput.status).toBe(TenantStatus.ACTIVE);
  });
});
