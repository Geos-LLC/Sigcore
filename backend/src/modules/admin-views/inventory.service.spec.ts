import { InventoryService } from './inventory.service';

function buildMockRepo() {
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
}

function makeQueryBuilder(rows: any[]) {
  const qb: any = {
    where: jest.fn(() => qb),
    orWhere: jest.fn(() => qb),
    andWhere: jest.fn(() => qb),
    innerJoin: jest.fn(() => qb),
    leftJoin: jest.fn(() => qb),
    select: jest.fn(() => qb),
    addSelect: jest.fn(() => qb),
    orderBy: jest.fn(() => qb),
    addOrderBy: jest.fn(() => qb),
    limit: jest.fn(() => qb),
    getMany: jest.fn(async () => rows),
    getRawMany: jest.fn(async () => rows),
  };
  return qb;
}

const WS = '1bcbb4e0-df1b-481c-83ba-0730df47a720';
const T_LAVANDA = '38380c75-1876-4984-b194-5fda7529835c';
const T_SF = 'ac582f7a-fb9c-4749-b70e-2085835a2532';

describe('InventoryService.listPhoneNumbers', () => {
  function build(currents: any[], legacies: any[], tenants: any[]) {
    const tpnRepo = buildMockRepo();
    const pnaRepo = buildMockRepo();
    const tenantRepo = buildMockRepo();
    // PR8 — InventoryService now also resolves the assignment chain. The
    // chain helper queries businesses + profiles + ppa, so we provide stub
    // repos that return empty arrays / no-op query builders. Existing tests
    // don't rely on chain output; the new chain unit tests live elsewhere.
    const bizRepo = buildMockRepo();
    const profileRepo = buildMockRepo();
    const ppaRepo = buildMockRepo();
    bizRepo.find.mockResolvedValue([]);
    profileRepo.find.mockResolvedValue([]);
    ppaRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([]));

    tpnRepo.find.mockResolvedValue(currents);
    pnaRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder(legacies));
    tenantRepo.find.mockResolvedValue(tenants);

    const service = new InventoryService(
      tpnRepo as any,
      pnaRepo as any,
      tenantRepo as any,
      bizRepo as any,
      profileRepo as any,
      ppaRepo as any,
    );
    return { service, tpnRepo, pnaRepo, tenantRepo, bizRepo, profileRepo, ppaRepo };
  }

  it('returns empty list when nothing exists', async () => {
    const { service } = build([], [], []);
    const out = await service.listPhoneNumbers(WS);
    expect(out).toEqual([]);
  });

  it('flags numbers that exist in BOTH tables', async () => {
    const { service } = build(
      [
        {
          id: 'tpn-1',
          workspaceId: WS,
          tenantId: T_LAVANDA,
          phoneNumber: '+16193303608',
          provider: 'twilio',
          a2pStatus: 'ready',
          status: 'active',
        },
      ],
      [
        {
          id: 'pna-1',
          businessId: WS, // workspace-level BOT pool
          numberE164: '+16193303608',
          type: 'BOT',
          active: true,
        },
      ],
      [{ id: T_LAVANDA, name: 'Lavanda Cleaning' }],
    );

    const rows = await service.listPhoneNumbers(WS);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.number).toBe('+16193303608');
    expect(row.model).toBe('BOTH');
    expect(row.provider).toBe('twilio');
    expect(row.a2pStatus).toBe('ready');
    expect(row.current?.tenantId).toBe(T_LAVANDA);
    expect(row.current?.tenantName).toBe('Lavanda Cleaning');
    expect(row.legacy?.businessId).toBe(WS);
    expect(row.legacy?.businessIdResolution).toBe('workspace');
    expect(row.legacy?.type).toBe('BOT');
  });

  it('flags numbers that exist only in tenant_phone_numbers as CURRENT', async () => {
    const { service } = build(
      [
        {
          id: 'tpn-2',
          workspaceId: WS,
          tenantId: T_SF,
          phoneNumber: '+15551112222',
          provider: 'twilio',
          a2pStatus: null,
          status: 'active',
        },
      ],
      [],
      [{ id: T_SF, name: 'Service Flow' }],
    );
    const rows = await service.listPhoneNumbers(WS);
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe('CURRENT');
    expect(rows[0].legacy).toBeNull();
    expect(rows[0].current?.tenantName).toBe('Service Flow');
  });

  it('flags numbers that exist only in phone_number_assignments as LEGACY', async () => {
    const { service } = build(
      [],
      [
        {
          id: 'pna-2',
          businessId: WS,
          numberE164: '+17273908889',
          type: 'BOT',
          active: true,
        },
      ],
      [],
    );
    const rows = await service.listPhoneNumbers(WS);
    expect(rows).toHaveLength(1);
    expect(rows[0].model).toBe('LEGACY');
    expect(rows[0].current).toBeNull();
    expect(rows[0].legacy?.businessIdResolution).toBe('workspace');
  });

  it('marks legacy rows owned by an unrelated id as unknown resolution', async () => {
    const { service } = build(
      [],
      [
        {
          id: 'pna-3',
          businessId: 'orphan-uuid-not-a-workspace-or-tenant',
          numberE164: '+15559998888',
          type: 'DEDICATED',
          active: false,
        },
      ],
      [{ id: T_LAVANDA, name: 'Lavanda Cleaning' }],
    );
    const rows = await service.listPhoneNumbers(WS);
    expect(rows).toHaveLength(1);
    expect(rows[0].legacy?.businessIdResolution).toBe('unknown');
    expect(rows[0].legacy?.active).toBe(false);
    expect(rows[0].legacy?.type).toBe('DEDICATED');
  });

  it('classifies a tenant-id business_id as tenant resolution', async () => {
    const { service } = build(
      [],
      [
        {
          id: 'pna-4',
          businessId: T_LAVANDA, // dedicated to a specific tenant
          numberE164: '+15554443333',
          type: 'DEDICATED',
          active: true,
        },
      ],
      [{ id: T_LAVANDA, name: 'Lavanda Cleaning' }],
    );
    const rows = await service.listPhoneNumbers(WS);
    expect(rows[0].legacy?.businessIdResolution).toBe('tenant');
  });

  it('filters by model badge', async () => {
    const { service } = build(
      [
        {
          id: 'tpn-a',
          workspaceId: WS,
          tenantId: T_LAVANDA,
          phoneNumber: '+15551110000',
          provider: 'twilio',
          a2pStatus: 'ready',
          status: 'active',
        },
        {
          id: 'tpn-b',
          workspaceId: WS,
          tenantId: T_LAVANDA,
          phoneNumber: '+15552220000',
          provider: 'twilio',
          a2pStatus: null,
          status: 'active',
        },
      ],
      [
        {
          id: 'pna-a',
          businessId: WS,
          numberE164: '+15551110000', // duplicate of tpn-a → BOTH
          type: 'BOT',
          active: true,
        },
        {
          id: 'pna-b',
          businessId: WS,
          numberE164: '+17270000000', // legacy-only
          type: 'BOT',
          active: true,
        },
      ],
      [{ id: T_LAVANDA, name: 'Lavanda Cleaning' }],
    );

    const both = await service.listPhoneNumbers(WS, { model: 'BOTH' });
    expect(both.map((r) => r.number)).toEqual(['+15551110000']);

    const current = await service.listPhoneNumbers(WS, { model: 'CURRENT' });
    expect(current.map((r) => r.number)).toEqual(['+15552220000']);

    const legacy = await service.listPhoneNumbers(WS, { model: 'LEGACY' });
    expect(legacy.map((r) => r.number)).toEqual(['+17270000000']);
  });

  it('filters by provider (case-insensitive)', async () => {
    const { service } = build(
      [
        {
          id: 'tpn-twilio',
          workspaceId: WS,
          tenantId: T_LAVANDA,
          phoneNumber: '+15551110000',
          provider: 'twilio',
          a2pStatus: null,
          status: 'active',
        },
        {
          id: 'tpn-op',
          workspaceId: WS,
          tenantId: T_LAVANDA,
          phoneNumber: '+15552220000',
          provider: 'openphone',
          a2pStatus: null,
          status: 'active',
        },
      ],
      [],
      [{ id: T_LAVANDA, name: 'Lavanda Cleaning' }],
    );

    const out = await service.listPhoneNumbers(WS, { provider: 'TWILIO' });
    expect(out).toHaveLength(1);
    expect(out[0].number).toBe('+15551110000');
  });

  it('orders BOTH > LEGACY > CURRENT, then by number', async () => {
    const { service } = build(
      [
        {
          id: 'tpn-c',
          workspaceId: WS,
          tenantId: T_LAVANDA,
          phoneNumber: '+15553330000',
          provider: 'twilio',
          a2pStatus: null,
          status: 'active',
        },
      ],
      [
        {
          id: 'pna-x',
          businessId: WS,
          numberE164: '+15553330000', // BOTH
          type: 'BOT',
          active: true,
        },
        {
          id: 'pna-y',
          businessId: WS,
          numberE164: '+15554440000', // LEGACY
          type: 'BOT',
          active: true,
        },
      ],
      [{ id: T_LAVANDA, name: 'Lavanda Cleaning' }],
    );

    const out = await service.listPhoneNumbers(WS);
    expect(out.map((r) => r.model)).toEqual(['BOTH', 'LEGACY']);
  });

  it('clamps limit to HARD_LIMIT', async () => {
    const big = Array.from({ length: 600 }, (_, i) => ({
      id: `tpn-${i}`,
      workspaceId: WS,
      tenantId: T_LAVANDA,
      phoneNumber: `+1555000${String(i).padStart(4, '0')}`,
      provider: 'twilio',
      a2pStatus: null,
      status: 'active',
    }));
    const { service } = build(big, [], [{ id: T_LAVANDA, name: 'Lavanda Cleaning' }]);
    const out = await service.listPhoneNumbers(WS, { limit: 9999 });
    expect(out.length).toBe(500);
  });
});

describe('InventoryService.listDuplications', () => {
  it('returns only BOTH rows', async () => {
    const tpnRepo = buildMockRepo();
    const pnaRepo = buildMockRepo();
    const tenantRepo = buildMockRepo();
    tpnRepo.find.mockResolvedValue([
      {
        id: 'tpn-a',
        workspaceId: WS,
        tenantId: T_LAVANDA,
        phoneNumber: '+15551110000',
        provider: 'twilio',
        a2pStatus: null,
        status: 'active',
      },
    ]);
    pnaRepo.createQueryBuilder.mockReturnValue(
      makeQueryBuilder([
        { id: 'pna-a', businessId: WS, numberE164: '+15551110000', type: 'BOT', active: true },
        { id: 'pna-b', businessId: WS, numberE164: '+15552220000', type: 'BOT', active: true },
      ]),
    );
    tenantRepo.find.mockResolvedValue([{ id: T_LAVANDA, name: 'Lavanda Cleaning' }]);
    const bizRepo = buildMockRepo();
    const profileRepo = buildMockRepo();
    const ppaRepo = buildMockRepo();
    bizRepo.find.mockResolvedValue([]);
    profileRepo.find.mockResolvedValue([]);
    ppaRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([]));
    const service = new InventoryService(
      tpnRepo as any,
      pnaRepo as any,
      tenantRepo as any,
      bizRepo as any,
      profileRepo as any,
      ppaRepo as any,
    );

    const dups = await service.listDuplications(WS);
    expect(dups).toHaveLength(1);
    expect(dups[0].number).toBe('+15551110000');
    expect(dups[0].model).toBe('BOTH');
  });
});
