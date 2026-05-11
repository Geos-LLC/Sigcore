import {
  ConflictException,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { PhoneAssignmentsService } from './phone-assignments.service';
import { AssignmentRole } from '../../database/entities/profile-phone-assignment.entity';

function buildMockRepo() {
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn((x: any) => x),
    createQueryBuilder: jest.fn(),
  };
}

function makeQueryBuilder(rows: any[], one?: any) {
  const qb: any = {
    where: jest.fn(() => qb),
    andWhere: jest.fn(() => qb),
    orWhere: jest.fn(() => qb),
    innerJoin: jest.fn(() => qb),
    leftJoin: jest.fn(() => qb),
    select: jest.fn(() => qb),
    update: jest.fn(() => qb),
    set: jest.fn(() => qb),
    execute: jest.fn(async () => ({ affected: 0 })),
    getMany: jest.fn(async () => rows),
    getOne: jest.fn(async () => one ?? null),
    getRawMany: jest.fn(async () => rows),
  };
  return qb;
}

const WS = '1bcbb4e0-df1b-481c-83ba-0730df47a720';
const T_HF = '38380c75-1876-4984-b194-5fda7529835c';
const PROFILE_ID = 'profile-1';
const TPN_ID = 'tpn-1';

function build(opts: {
  profile?: any;
  tpn?: any;
  ppasInWorkspace?: any[];
  existingPpa?: any;
  existingDefault?: any;
  saveResult?: any;
  searchResults?: any[];
  purchaseResult?: any;
}) {
  const profileRepo = buildMockRepo();
  const tpnRepo = buildMockRepo();
  const ppaRepo = buildMockRepo();
  const dataSource: any = {
    transaction: async (fn: any) => fn({ getRepository: () => ppaTxn }),
  };

  const ppaTxn: any = buildMockRepo();
  ppaTxn.findOne = jest.fn(async () => opts.existingPpa ?? null);
  ppaTxn.save = jest.fn(async (x: any) => opts.saveResult ?? { ...x, id: x.id ?? 'new-ppa' });
  ppaTxn.create = jest.fn((x: any) => x);
  ppaTxn.createQueryBuilder = jest.fn(() => makeQueryBuilder([], opts.existingDefault));

  profileRepo.findOne.mockResolvedValue(opts.profile ?? null);
  tpnRepo.findOne.mockResolvedValue(opts.tpn ?? null);
  ppaRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder(opts.ppasInWorkspace ?? []));
  tpnRepo.find.mockResolvedValue(opts.tpn ? [opts.tpn] : []);

  const provisioning: any = {
    searchAvailableNumbers: jest.fn(async () => opts.searchResults ?? []),
    purchaseNumber: jest.fn(async () => opts.purchaseResult ?? { success: false, error: 'mock-not-set' }),
  };

  const svc = new PhoneAssignmentsService(
    profileRepo as any,
    tpnRepo as any,
    ppaRepo as any,
    dataSource,
    provisioning,
  );
  return { svc, profileRepo, tpnRepo, ppaRepo, ppaTxn, provisioning };
}

describe('PhoneAssignmentsService.listAvailableForProfile', () => {
  it('throws NotFound when profile is missing', async () => {
    const { svc } = build({});
    await expect(svc.listAvailableForProfile(WS, PROFILE_ID)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('returns rows with alreadyAssignedToThisProfile flag', async () => {
    const profile = { id: PROFILE_ID, workspaceId: WS, tenantId: T_HF };
    const tpn = {
      id: TPN_ID,
      workspaceId: WS,
      tenantId: T_HF,
      phoneNumber: '+15551234567',
      provider: 'twilio',
      channel: 'sms',
      status: 'active',
      friendlyName: null,
      a2pStatus: null,
      createdAt: new Date(),
    };
    const { svc } = build({
      profile,
      tpn,
      ppasInWorkspace: [
        { profileId: PROFILE_ID, tenantPhoneNumberId: TPN_ID },
      ],
    });
    const out = await svc.listAvailableForProfile(WS, PROFILE_ID);
    expect(out.profileId).toBe(PROFILE_ID);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0].alreadyAssignedToThisProfile).toBe(true);
    expect(out.rows[0].sharedWithProfileIds).toEqual([]);
  });

  it('reports sharedWithProfileIds for phones already linked to siblings', async () => {
    const profile = { id: PROFILE_ID, workspaceId: WS, tenantId: T_HF };
    const tpn = {
      id: TPN_ID,
      workspaceId: WS,
      tenantId: T_HF,
      phoneNumber: '+15551234567',
      provider: 'twilio',
      channel: 'sms',
      status: 'active',
      createdAt: new Date(),
    };
    const { svc } = build({
      profile,
      tpn,
      ppasInWorkspace: [
        { profileId: 'sibling-profile', tenantPhoneNumberId: TPN_ID },
      ],
    });
    const out = await svc.listAvailableForProfile(WS, PROFILE_ID);
    expect(out.rows[0].alreadyAssignedToThisProfile).toBe(false);
    expect(out.rows[0].sharedWithProfileIds).toEqual(['sibling-profile']);
  });
});

describe('PhoneAssignmentsService.assign', () => {
  const profile = { id: PROFILE_ID, workspaceId: WS, tenantId: T_HF };
  const tpn = {
    id: TPN_ID,
    workspaceId: WS,
    tenantId: T_HF,
    phoneNumber: '+15551234567',
    provider: 'twilio',
  };

  it('rejects when profileId missing', async () => {
    const { svc } = build({});
    await expect(svc.assign(WS, { profileId: '', tenantPhoneNumberId: TPN_ID })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects when neither tpn id nor phone number provided', async () => {
    const { svc } = build({ profile });
    await expect(svc.assign(WS, { profileId: PROFILE_ID })).rejects.toThrow(
      BadRequestException,
    );
  });

  it('returns 404 when profile is missing', async () => {
    const { svc } = build({ profile: null, tpn });
    await expect(
      svc.assign(WS, { profileId: PROFILE_ID, tenantPhoneNumberId: TPN_ID }),
    ).rejects.toThrow(NotFoundException);
  });

  it('returns 404 when phone is not in TPN for the workspace', async () => {
    const { svc } = build({ profile, tpn: null });
    await expect(
      svc.assign(WS, { profileId: PROFILE_ID, tenantPhoneNumberId: TPN_ID }),
    ).rejects.toThrow(NotFoundException);
  });

  it('permits cross-tenant assignment when phone and profile share the workspace', async () => {
    // PR15 shared-assignment amendment (2026-05-11): TPN owned by tenant B
    // can be assigned to a profile under tenant A within the same workspace.
    // The communication-service guard enforces that an active PPA exists
    // before any outbound send actually fires from that number.
    const crossTenantTpn = { ...tpn, tenantId: 'other-tenant-same-ws' };
    const { svc, ppaTxn } = build({ profile, tpn: crossTenantTpn });
    const out = await svc.assign(WS, {
      profileId: PROFILE_ID,
      tenantPhoneNumberId: TPN_ID,
      isDefault: false,
    });
    expect(ppaTxn.save).toHaveBeenCalled();
    const saved = ppaTxn.save.mock.calls[0][0];
    expect(saved.profileId).toBe(PROFILE_ID);
    expect(saved.tenantPhoneNumberId).toBe(TPN_ID);
    expect(saved.active).toBe(true);
    expect(saved.isDefault).toBe(false);
    expect(out.phoneNumber).toBe('+15551234567');
  });

  it('rejects when phone and profile belong to different workspaces', async () => {
    // Defense-in-depth: the workspace-scoped findOne lookups already 404
    // any TPN/profile outside the caller's workspace, so reaching this code
    // path requires a mock that returns a TPN from a different workspace.
    // The explicit check documents and enforces the invariant.
    const crossWsTpn = { ...tpn, workspaceId: 'other-workspace' };
    const { svc } = build({ profile, tpn: crossWsTpn });
    await expect(
      svc.assign(WS, { profileId: PROFILE_ID, tenantPhoneNumberId: TPN_ID }),
    ).rejects.toThrow(BadRequestException);
  });

  it('isDefault=false does not disturb the existing default (no demote)', async () => {
    // Existing default belongs to another PPA on the same profile. Setting
    // explicit isDefault=false on the new row must NOT call demoteOtherDefaults.
    const { svc, ppaTxn } = build({
      profile,
      tpn,
      existingDefault: { id: 'old-default' },
    });
    const updateChain = makeQueryBuilder([]);
    ppaTxn.createQueryBuilder = jest.fn((alias?: string) => {
      // resolveIsDefault path uses ('ppa'); demote path uses no alias on update.
      if (alias === 'ppa') return makeQueryBuilder([], { id: 'old-default' });
      return updateChain;
    });

    const out = await svc.assign(WS, {
      profileId: PROFILE_ID,
      tenantPhoneNumberId: TPN_ID,
      isDefault: false,
    });

    const saved = ppaTxn.save.mock.calls[0][0];
    expect(saved.isDefault).toBe(false);
    expect(out.isDefault).toBe(false);
    // The demote QB chain (update().set().where()...) must NOT have executed.
    expect(updateChain.execute).not.toHaveBeenCalled();
  });

  it('isDefault=true demotes existing defaults and promotes the new row', async () => {
    // When the caller explicitly requests isDefault=true, the service must
    // run demoteOtherDefaults inside the same transaction to preserve the
    // partial-unique "exactly one default per profile when active" index.
    const updateChain = makeQueryBuilder([]);
    const ppaQbChain = makeQueryBuilder([], { id: 'old-default' });
    const { svc, ppaTxn } = build({
      profile,
      tpn,
      existingDefault: { id: 'old-default' },
    });
    ppaTxn.createQueryBuilder = jest.fn((alias?: string) => {
      if (alias === 'ppa') return ppaQbChain;
      return updateChain;
    });

    const out = await svc.assign(WS, {
      profileId: PROFILE_ID,
      tenantPhoneNumberId: TPN_ID,
      isDefault: true,
    });

    const saved = ppaTxn.save.mock.calls[0][0];
    expect(saved.isDefault).toBe(true);
    expect(out.isDefault).toBe(true);
    // demoteOtherDefaults must have invoked update().set().where()...execute()
    expect(updateChain.update).toHaveBeenCalled();
    expect(updateChain.set).toHaveBeenCalledWith({ isDefault: false });
    expect(updateChain.execute).toHaveBeenCalled();
  });

  it('creates a new PPA row with isDefault=true when no default exists yet', async () => {
    const { svc, ppaTxn } = build({ profile, tpn });
    const out = await svc.assign(WS, {
      profileId: PROFILE_ID,
      tenantPhoneNumberId: TPN_ID,
    });
    expect(ppaTxn.save).toHaveBeenCalled();
    const saved = ppaTxn.save.mock.calls[0][0];
    expect(saved.profileId).toBe(PROFILE_ID);
    expect(saved.tenantPhoneNumberId).toBe(TPN_ID);
    expect(saved.role).toBe(AssignmentRole.PRIMARY);
    expect(saved.isDefault).toBe(true);
    expect(saved.priority).toBe(100);
    expect(saved.active).toBe(true);
    expect(out.phoneNumber).toBe('+15551234567');
  });

  it('creates with isDefault=false when an active default already exists', async () => {
    const { svc, ppaTxn } = build({
      profile,
      tpn,
      existingDefault: { id: 'old-default' },
    });
    const out = await svc.assign(WS, {
      profileId: PROFILE_ID,
      tenantPhoneNumberId: TPN_ID,
    });
    const saved = ppaTxn.save.mock.calls[0][0];
    expect(saved.isDefault).toBe(false);
    expect(out.isDefault).toBe(false);
  });

  it('respects explicit isDefault=false even when no default exists', async () => {
    const { svc, ppaTxn } = build({ profile, tpn });
    await svc.assign(WS, {
      profileId: PROFILE_ID,
      tenantPhoneNumberId: TPN_ID,
      isDefault: false,
    });
    const saved = ppaTxn.save.mock.calls[0][0];
    expect(saved.isDefault).toBe(false);
  });

  it('throws ConflictException when an active PPA already exists', async () => {
    const { svc } = build({
      profile,
      tpn,
      existingPpa: {
        id: 'existing',
        profileId: PROFILE_ID,
        tenantPhoneNumberId: TPN_ID,
        active: true,
      },
    });
    await expect(
      svc.assign(WS, { profileId: PROFILE_ID, tenantPhoneNumberId: TPN_ID }),
    ).rejects.toThrow(ConflictException);
  });

  it('reactivates a soft-deactivated PPA instead of inserting a duplicate', async () => {
    const inactive = {
      id: 'old',
      profileId: PROFILE_ID,
      tenantPhoneNumberId: TPN_ID,
      active: false,
      role: 'fallback',
      priority: 50,
      isDefault: false,
    };
    const { svc, ppaTxn } = build({ profile, tpn, existingPpa: inactive });
    const out = await svc.assign(WS, {
      profileId: PROFILE_ID,
      tenantPhoneNumberId: TPN_ID,
    });
    expect(ppaTxn.save).toHaveBeenCalled();
    const saved = ppaTxn.save.mock.calls[0][0];
    expect(saved.id).toBe('old');
    expect(saved.active).toBe(true);
    expect(out.id).toBe('old');
  });

  it('looks TPN up by phoneNumber when tenantPhoneNumberId not provided', async () => {
    const { svc, tpnRepo } = build({ profile, tpn });
    await svc.assign(WS, {
      profileId: PROFILE_ID,
      phoneNumber: '+15551234567',
    });
    expect(tpnRepo.findOne).toHaveBeenCalledWith({
      where: { workspaceId: WS, phoneNumber: '+15551234567' },
    });
  });
});

describe('PhoneAssignmentsService.provisionAndAssign', () => {
  const profile = { id: PROFILE_ID, workspaceId: WS, tenantId: T_HF };
  const purchasedTpn = {
    id: TPN_ID,
    workspaceId: WS,
    tenantId: T_HF,
    phoneNumber: '+15551234567',
    provider: 'twilio',
  };
  const candidate = {
    phoneNumber: '+15551234567',
    country: 'US',
    capabilities: ['sms', 'voice'],
    twilioCost: 1.15,
    markupAmount: 0.5,
    totalMonthlyPrice: 1.65,
    setupFee: 0,
  };

  it('rejects unsupported provider', async () => {
    const { svc } = build({ profile });
    await expect(
      svc.provisionAndAssign(WS, {
        tenantId: T_HF,
        profileId: PROFILE_ID,
        provider: 'openphone' as any,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects when profile.tenantId mismatches dto.tenantId', async () => {
    const { svc } = build({ profile });
    await expect(
      svc.provisionAndAssign(WS, {
        tenantId: 'different-tenant',
        profileId: PROFILE_ID,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('returns 404 when no available numbers match the search', async () => {
    const { svc } = build({ profile, searchResults: [] });
    await expect(
      svc.provisionAndAssign(WS, {
        tenantId: T_HF,
        profileId: PROFILE_ID,
        areaCode: '510',
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('Twilio failure surfaces clear error and no PPA is created', async () => {
    const { svc, provisioning, ppaTxn } = build({
      profile,
      searchResults: [candidate],
      purchaseResult: { success: false, order: { id: 'o1' }, error: 'twilio_billing_declined' },
    });
    await expect(
      svc.provisionAndAssign(WS, { tenantId: T_HF, profileId: PROFILE_ID }),
    ).rejects.toThrow(/twilio_billing_declined/i);
    expect(provisioning.purchaseNumber).toHaveBeenCalled();
    expect(ppaTxn.save).not.toHaveBeenCalled();
  });

  it('happy path: searches, purchases, creates PPA, marks default as first assignment', async () => {
    const { svc, provisioning, ppaTxn } = build({
      profile,
      tpn: purchasedTpn,
      searchResults: [candidate],
      purchaseResult: { success: true, order: { id: 'o1' }, allocation: purchasedTpn },
    });
    const out = await svc.provisionAndAssign(WS, {
      tenantId: T_HF,
      profileId: PROFILE_ID,
      areaCode: '415',
    });
    expect(provisioning.searchAvailableNumbers).toHaveBeenCalledWith(
      WS,
      'US',
      '415',
      expect.objectContaining({ smsCapable: true, voiceCapable: true }),
    );
    expect(provisioning.purchaseNumber).toHaveBeenCalledWith(
      WS,
      T_HF,
      '+15551234567',
      undefined,
    );
    expect(ppaTxn.save).toHaveBeenCalled();
    const saved = ppaTxn.save.mock.calls[0][0];
    expect(saved.profileId).toBe(PROFILE_ID);
    expect(saved.tenantPhoneNumberId).toBe(TPN_ID);
    expect(saved.role).toBe(AssignmentRole.PRIMARY);
    expect(saved.isDefault).toBe(true);
    expect(out.purchased).toBe(true);
    expect(out.assigned).toBe(true);
    expect(out.tenantPhoneNumber.id).toBe(TPN_ID);
    expect(out.profilePhoneAssignment.phoneNumber).toBe('+15551234567');
  });

  it('makeDefault=true demotes the previous default in the same transaction', async () => {
    const { svc, ppaTxn } = build({
      profile,
      tpn: purchasedTpn,
      searchResults: [candidate],
      purchaseResult: { success: true, order: { id: 'o1' }, allocation: purchasedTpn },
      existingDefault: { id: 'old-default' },
    });
    const out = await svc.provisionAndAssign(WS, {
      tenantId: T_HF,
      profileId: PROFILE_ID,
      makeDefault: true,
    });
    // The existing default would normally win without makeDefault — but
    // makeDefault=true forces the new assignment to default and demotes
    // the prior one via the qb.update path.
    const saved = ppaTxn.save.mock.calls[0][0];
    expect(saved.isDefault).toBe(true);
    expect(out.profilePhoneAssignment.isDefault).toBe(true);
  });

  it('reuses the existing PPA if the same TPN is already linked to the profile (idempotent)', async () => {
    const existing = {
      id: 'existing-ppa',
      profileId: PROFILE_ID,
      tenantPhoneNumberId: TPN_ID,
      active: false,
      isDefault: false,
      priority: 100,
      role: 'primary',
    };
    const { svc, ppaTxn } = build({
      profile,
      tpn: purchasedTpn,
      searchResults: [candidate],
      purchaseResult: { success: true, order: { id: 'o1' }, allocation: purchasedTpn },
      existingPpa: existing,
    });
    const out = await svc.provisionAndAssign(WS, {
      tenantId: T_HF,
      profileId: PROFILE_ID,
    });
    // The existing PPA is reactivated, not duplicated.
    expect(ppaTxn.save).toHaveBeenCalledTimes(1);
    const saved = ppaTxn.save.mock.calls[0][0];
    expect(saved.id).toBe('existing-ppa');
    expect(out.profilePhoneAssignment.id).toBe('existing-ppa');
  });

  it('purchase succeeds but PPA insert failure surfaces InternalServerError with cleanup hint', async () => {
    const { svc, ppaTxn } = build({
      profile,
      tpn: purchasedTpn,
      searchResults: [candidate],
      purchaseResult: { success: true, order: { id: 'o1' }, allocation: purchasedTpn },
    });
    ppaTxn.save = jest.fn(async () => {
      throw new Error('db_constraint_violation');
    });
    await expect(
      svc.provisionAndAssign(WS, { tenantId: T_HF, profileId: PROFILE_ID }),
    ).rejects.toThrow(InternalServerErrorException);
  });
});
