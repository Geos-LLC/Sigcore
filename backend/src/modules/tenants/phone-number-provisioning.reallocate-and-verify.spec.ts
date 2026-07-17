import { PhoneNumberProvisioningService } from './phone-number-provisioning.service';
import { PhoneNumberProvider } from '../../database/entities';
import { IntegrationStatus, ProviderType } from '../../database/entities/communication-integration.entity';

/**
 * Service-level wiring test for the 2026-07-13 fix:
 * `reallocatePhoneNumber` must call `ensureOutboundReady` after saving the
 * re-homed allocation so outbound resolution accepts the new owner tenant
 * immediately. Before this fix the TPN was re-homed but the tenant lacked
 * a communication_businesses / communication_profiles /
 * profile_phone_assignments chain — POST /api/v1/messages then 422'd with
 * INVALID_PROFILE_PHONE.
 *
 * The verify endpoint (also introduced in the same PR) is exercised here
 * against the same repo stubs — start empty (all missing), then re-verify
 * after the ensure-step has run.
 */

const WS = '1bcbb4e0-df1b-481c-83ba-0730df47a720';
const OLD_TENANT = '00000000-0000-0000-0000-000000000001';
const NEW_TENANT = '11111111-1111-1111-1111-111111111111';
const TPN_ID = 'tpn-abc';
const PHONE = '+19998887777';

function makeRepoStub<T extends Record<string, any>>(seed: T[] = []) {
  const rows: any[] = [...seed];
  let n = 1;
  const stub: any = {
    rows,
    findOne: jest.fn(async ({ where }: any) =>
      rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null,
    ),
    find: jest.fn(async ({ where }: any) =>
      rows.filter((r) => Object.entries(where ?? {}).every(([k, v]) => r[k] === v)),
    ),
    create: jest.fn((x: any) => ({ ...x })),
    save: jest.fn(async (entity: any) => {
      if (!entity.id) entity.id = `row-${n++}`;
      const idx = rows.findIndex((r) => r.id === entity.id);
      if (idx >= 0) rows[idx] = { ...rows[idx], ...entity };
      else rows.push(entity);
      return entity;
    }),
    createQueryBuilder: jest.fn(() => {
      const state: any = { andWhere: [], from: null, join: [], select: null, tpnIdFilter: null };
      const qb: any = {
        innerJoin: jest.fn((_e: any, _alias: string, _cond: string) => qb),
        where: jest.fn((_cond: string, params: any = {}) => {
          Object.assign(state, params);
          return qb;
        }),
        andWhere: jest.fn((_cond: string, params: any = {}) => {
          Object.assign(state, params);
          return qb;
        }),
        select: jest.fn(() => qb),
        addSelect: jest.fn(() => qb),
        orderBy: jest.fn(() => qb),
        addOrderBy: jest.fn(() => qb),
        limit: jest.fn(() => qb),
        getMany: jest.fn(async () => {
          if (state.pids) {
            return rows.filter(
              (r) => state.pids.includes(r.profileId) && (state.tpnId ? r.tenantPhoneNumberId === state.tpnId : true),
            );
          }
          if (state.bids) return rows.filter((r) => state.bids.includes(r.communicationBusinessId));
          return rows;
        }),
        getRawMany: jest.fn(async () => []),
        getRawOne: jest.fn(async () => null),
        getCount: jest.fn(async () => {
          if (state.phone && state.tenantId) {
            return rows.filter(
              (r) => r._phone === state.phone && r._profileTenantId === state.tenantId && r.active,
            ).length;
          }
          return 0;
        }),
      };
      return qb;
    }),
  };
  return stub;
}

function buildService(opts: {
  existingTpn?: any;
  tenantSeed?: any[];
} = {}) {
  const orderRepo = makeRepoStub();
  const pricingRepo = { findOne: jest.fn(async () => null) };

  const initialTpn = opts.existingTpn ?? {
    id: TPN_ID,
    workspaceId: WS,
    tenantId: OLD_TENANT,
    phoneNumber: PHONE,
    provider: PhoneNumberProvider.TWILIO,
    providerId: 'PNxxx',
    status: 'active',
    a2pStatus: 'ready',
  };
  const tenantPhoneRepo = makeRepoStub([initialTpn]);

  const integrationRepo = {
    findOne: jest.fn(async () => ({
      id: 'int-1',
      workspaceId: WS,
      provider: ProviderType.TWILIO,
      status: IntegrationStatus.ACTIVE,
      credentialsEncrypted: 'enc',
    })),
  };

  const tenantRepo = makeRepoStub(
    opts.tenantSeed ?? [
      { id: OLD_TENANT, workspaceId: WS, name: 'OldTenant', externalId: 'old-ext' },
      { id: NEW_TENANT, workspaceId: WS, name: 'NewTenant', externalId: 'new-ext' },
    ],
  );
  const workspaceRepo = { findOne: jest.fn(async () => ({ id: WS, webhookId: 'wh-hex' })) };
  const communicationBusinessRepo = makeRepoStub();
  const communicationProfileRepo = makeRepoStub();
  const profilePhoneAssignmentRepo = makeRepoStub();
  const webhookSubscriptionRepo = makeRepoStub();
  const apiKeyRepo = makeRepoStub([
    { id: 'k-new', tenantId: NEW_TENANT, name: 'LeadBridge Key' },
  ]);

  const encryptionService: any = { decrypt: jest.fn(() => ({ accountSid: 'AC', authToken: 'tok' })) };
  const twilioProvider: any = {
    configureWebhooks: jest.fn(async () => undefined),
    getPhoneNumberSid: jest.fn(async () => 'PNfresh'),
  };
  const configService: any = {
    get: jest.fn((key: string) => (key === 'BASE_URL' ? 'https://sigcore.test' : undefined)),
  };
  const subaccountProvisioner: any = { ensureReady: jest.fn(async () => ({ credentialsEncrypted: 'enc' })) };

  const svc = new PhoneNumberProvisioningService(
    orderRepo as any,
    pricingRepo as any,
    tenantPhoneRepo as any,
    integrationRepo as any,
    tenantRepo as any,
    workspaceRepo as any,
    communicationBusinessRepo as any,
    communicationProfileRepo as any,
    profilePhoneAssignmentRepo as any,
    webhookSubscriptionRepo as any,
    apiKeyRepo as any,
    encryptionService,
    twilioProvider,
    configService,
    subaccountProvisioner,
  );

  return {
    svc,
    tenantPhoneRepo,
    tenantRepo,
    communicationBusinessRepo,
    communicationProfileRepo,
    profilePhoneAssignmentRepo,
    apiKeyRepo,
    webhookSubscriptionRepo,
  };
}

describe('PhoneNumberProvisioningService.reallocatePhoneNumber — ensureOutboundReady wiring', () => {
  it('re-homes existing TPN and materializes the outbound chain for the new tenant', async () => {
    const ctx = buildService();

    const allocation = await ctx.svc.reallocatePhoneNumber(WS, PHONE, NEW_TENANT);

    // TPN was re-homed
    expect(allocation.tenantId).toBe(NEW_TENANT);
    expect(ctx.tenantPhoneRepo.rows[0].tenantId).toBe(NEW_TENANT);

    // Chain materialized for the NEW tenant (not the old owner)
    expect(ctx.communicationBusinessRepo.rows).toHaveLength(1);
    expect(ctx.communicationBusinessRepo.rows[0].tenantId).toBe(NEW_TENANT);
    expect(ctx.communicationProfileRepo.rows).toHaveLength(1);
    expect(ctx.communicationProfileRepo.rows[0].tenantId).toBe(NEW_TENANT);
    expect(ctx.profilePhoneAssignmentRepo.rows).toHaveLength(1);
    expect(ctx.profilePhoneAssignmentRepo.rows[0]).toMatchObject({
      profileId: ctx.communicationProfileRepo.rows[0].id,
      tenantPhoneNumberId: TPN_ID,
      active: true,
      isDefault: true,
    });
  });

  it('creates TPN + chain when reallocating a phone that has no prior record', async () => {
    const ctx = buildService({ existingTpn: null as any });
    // Empty out the seed
    ctx.tenantPhoneRepo.rows.length = 0;

    const allocation = await ctx.svc.reallocatePhoneNumber(WS, PHONE, NEW_TENANT);

    expect(allocation.tenantId).toBe(NEW_TENANT);
    expect(ctx.tenantPhoneRepo.rows).toHaveLength(1);
    expect(ctx.communicationBusinessRepo.rows).toHaveLength(1);
    expect(ctx.profilePhoneAssignmentRepo.rows).toHaveLength(1);
  });

  it('chain materialization failure does NOT roll back the re-home', async () => {
    const ctx = buildService();
    ctx.communicationBusinessRepo.save.mockImplementationOnce(async () => {
      throw new Error('synthetic DB failure');
    });

    const allocation = await ctx.svc.reallocatePhoneNumber(WS, PHONE, NEW_TENANT);

    // Re-home succeeded, TPN persisted with new owner
    expect(allocation.tenantId).toBe(NEW_TENANT);
    expect(ctx.tenantPhoneRepo.rows[0].tenantId).toBe(NEW_TENANT);
    // Chain missing — recoverable
    expect(ctx.profilePhoneAssignmentRepo.rows).toHaveLength(0);
  });

  it('re-homing the same TPN twice does not duplicate chain rows', async () => {
    const ctx = buildService();

    await ctx.svc.reallocatePhoneNumber(WS, PHONE, NEW_TENANT);
    await ctx.svc.reallocatePhoneNumber(WS, PHONE, NEW_TENANT);

    expect(ctx.communicationBusinessRepo.rows).toHaveLength(1);
    expect(ctx.communicationProfileRepo.rows).toHaveLength(1);
    expect(ctx.profilePhoneAssignmentRepo.rows).toHaveLength(1);
  });
});

describe('PhoneNumberProvisioningService.verifyPhoneNumberOutbound', () => {
  it('TPN missing -> ok=false, resolver.reason=TPN_NOT_FOUND, missing=[tpn]', async () => {
    const ctx = buildService({ existingTpn: null as any });
    ctx.tenantPhoneRepo.rows.length = 0;

    const result = await ctx.svc.verifyPhoneNumberOutbound(WS, NEW_TENANT, PHONE);

    expect(result.ok).toBe(false);
    expect(result.tpn.exists).toBe(false);
    expect(result.resolver.reason).toBe('TPN_NOT_FOUND');
    expect(result.missing).toEqual(['tpn']);
  });

  it('TPN present but no chain -> ok=false, reason=INVALID_PROFILE_PHONE, missing=[business,profile,ppa]', async () => {
    const ctx = buildService();

    const result = await ctx.svc.verifyPhoneNumberOutbound(WS, NEW_TENANT, PHONE);

    expect(result.ok).toBe(false);
    expect(result.tpn).toMatchObject({ exists: true, id: TPN_ID });
    expect(result.business.exists).toBe(false);
    expect(result.profile.exists).toBe(false);
    expect(result.ppa.exists).toBe(false);
    expect(result.resolver.reason).toBe('INVALID_PROFILE_PHONE');
    expect(result.missing).toEqual(['business', 'profile', 'ppa']);
  });

  it('after reallocatePhoneNumber materializes the chain, verify returns ok=true', async () => {
    const ctx = buildService();

    await ctx.svc.reallocatePhoneNumber(WS, PHONE, NEW_TENANT);

    // Seed the row shape the resolver-mirror getCount looks for
    const ppa = ctx.profilePhoneAssignmentRepo.rows[0];
    ppa._phone = PHONE;
    ppa._profileTenantId = NEW_TENANT;

    const result = await ctx.svc.verifyPhoneNumberOutbound(WS, NEW_TENANT, PHONE);

    expect(result.ok).toBe(true);
    expect(result.tpn).toMatchObject({ exists: true, id: TPN_ID });
    expect(result.business.exists).toBe(true);
    expect(result.profile.exists).toBe(true);
    expect(result.ppa.exists).toBe(true);
    expect(result.resolver.reason).toBe('ok');
    expect(result.resolver.matches).toBe(1);
    expect(result.missing).toEqual([]);
  });

  it('accepts phoneNumber without leading + and normalizes', async () => {
    const ctx = buildService();

    const result = await ctx.svc.verifyPhoneNumberOutbound(WS, NEW_TENANT, '19998887777');

    expect(result.phoneNumber).toBe(PHONE);
    expect(result.tpn.exists).toBe(true);
  });
});
