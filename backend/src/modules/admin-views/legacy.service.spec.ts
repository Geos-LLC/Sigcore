import { LegacyService } from './legacy.service';
import { SmsDirection, SmsStatus } from '../../database/entities/sms-message.entity';

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
    getMany: jest.fn(async () => rows),
  };
  return qb;
}

const WS = '1bcbb4e0-df1b-481c-83ba-0730df47a720';
const T_LAVANDA = '38380c75-1876-4984-b194-5fda7529835c';
const ORPHAN = 'orphan-uuid';

function buildService() {
  const pnaRepo = buildMockRepo();
  const tenantRepo = buildMockRepo();
  const workspaceRepo = buildMockRepo();
  const smsRepo = buildMockRepo();
  const inventoryService = { listDuplications: jest.fn(), listPhoneNumbers: jest.fn() };
  const service = new LegacyService(
    pnaRepo as any,
    tenantRepo as any,
    workspaceRepo as any,
    smsRepo as any,
    inventoryService as any,
  );
  return { service, pnaRepo, tenantRepo, workspaceRepo, smsRepo, inventoryService };
}

describe('LegacyService.listAssignments', () => {
  it('groups rows by business_id and resolves workspace/tenant/unknown', async () => {
    const { service, pnaRepo, tenantRepo, workspaceRepo } = buildService();
    tenantRepo.find.mockResolvedValue([{ id: T_LAVANDA, name: 'Lavanda Cleaning' }]);
    workspaceRepo.findOne.mockResolvedValue({ id: WS, name: 'Workspace 1bcbb4e0' });
    pnaRepo.createQueryBuilder.mockReturnValue(
      makeQueryBuilder([
        {
          id: 'pna-1',
          businessId: WS,
          numberE164: '+17273908889',
          type: 'BOT',
          region: null,
          active: true,
          createdAt: new Date('2026-02-22T03:03:19.805Z'),
        },
        {
          id: 'pna-2',
          businessId: WS,
          numberE164: '+19045778584',
          type: 'BOT',
          region: null,
          active: true,
          createdAt: new Date('2026-04-26T20:53:31.442Z'),
        },
        {
          id: 'pna-3',
          businessId: T_LAVANDA, // dedicated to a tenant
          numberE164: '+15554443333',
          type: 'DEDICATED',
          region: 'US',
          active: true,
          createdAt: new Date('2026-04-01T00:00:00.000Z'),
        },
        {
          id: 'pna-4',
          businessId: ORPHAN,
          numberE164: '+15559998888',
          type: 'BOT',
          region: null,
          active: false,
          createdAt: new Date('2026-03-01T00:00:00.000Z'),
        },
      ]),
    );

    const groups = await service.listAssignments(WS);
    expect(groups.map((g) => g.resolution)).toEqual(['workspace', 'tenant', 'unknown']);

    const wsGroup = groups[0];
    expect(wsGroup.businessId).toBe(WS);
    expect(wsGroup.resolvedName).toBe('Workspace 1bcbb4e0');
    expect(wsGroup.rows).toHaveLength(2);
    // ordered by createdAt ascending
    expect(wsGroup.rows[0].numberE164).toBe('+17273908889');
    expect(wsGroup.rows[1].numberE164).toBe('+19045778584');

    const tGroup = groups[1];
    expect(tGroup.resolvedName).toBe('Lavanda Cleaning');
    expect(tGroup.rows[0].type).toBe('DEDICATED');

    const oGroup = groups[2];
    expect(oGroup.resolution).toBe('unknown');
    expect(oGroup.resolvedName).toBeNull();
  });

  it('returns an empty list when no assignments exist', async () => {
    const { service, pnaRepo, tenantRepo, workspaceRepo } = buildService();
    tenantRepo.find.mockResolvedValue([]);
    workspaceRepo.findOne.mockResolvedValue({ id: WS, name: 'WS' });
    pnaRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder([]));
    const groups = await service.listAssignments(WS);
    expect(groups).toEqual([]);
  });
});

describe('LegacyService.listDuplications', () => {
  it('delegates to InventoryService', async () => {
    const { service, inventoryService } = buildService();
    inventoryService.listDuplications.mockResolvedValue([
      { number: '+1', provider: 'twilio', a2pStatus: null, model: 'BOTH', current: null, legacy: null },
    ] as any);

    const out = await service.listDuplications(WS);
    expect(inventoryService.listDuplications).toHaveBeenCalledWith(WS);
    expect(out).toHaveLength(1);
    expect(out[0].model).toBe('BOTH');
  });
});

describe('LegacyService.listSmsMessages', () => {
  it('returns recent rows scoped to workspace + its tenants with resolution', async () => {
    const { service, tenantRepo, smsRepo } = buildService();
    tenantRepo.find.mockResolvedValue([{ id: T_LAVANDA }]);
    smsRepo.find.mockResolvedValue([
      {
        id: 'sms-1',
        businessId: WS,
        direction: SmsDirection.OUTBOUND,
        status: SmsStatus.DELIVERED,
        fromNumber: '+17273908889',
        toNumber: '+12483462681',
        body: 'test',
        providerSid: 'SM6feb...',
        createdAt: new Date('2026-02-22T03:03:38.674Z'),
      },
      {
        id: 'sms-2',
        businessId: T_LAVANDA,
        direction: SmsDirection.INBOUND,
        status: SmsStatus.RECEIVED,
        fromNumber: '+19719982082',
        toNumber: '+16193303608',
        body: '9am?',
        providerSid: 'SMa87fd...',
        createdAt: new Date('2026-04-27T17:08:53.739Z'),
      },
    ]);

    const rows = await service.listSmsMessages(WS);
    expect(rows).toHaveLength(2);
    expect(rows[0].resolution).toBe('workspace');
    expect(rows[0].direction).toBe('OUTBOUND');
    expect(rows[1].resolution).toBe('tenant');
    expect(rows[1].direction).toBe('INBOUND');
  });

  it('clamps the limit to the hard cap', async () => {
    const { service, tenantRepo, smsRepo } = buildService();
    tenantRepo.find.mockResolvedValue([]);
    smsRepo.find.mockResolvedValue([]);
    await service.listSmsMessages(WS, 9999);
    expect(smsRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ take: 500 }),
    );
  });

  it('uses the default limit when none is provided', async () => {
    const { service, tenantRepo, smsRepo } = buildService();
    tenantRepo.find.mockResolvedValue([]);
    smsRepo.find.mockResolvedValue([]);
    await service.listSmsMessages(WS);
    expect(smsRepo.find).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100 }),
    );
  });
});
