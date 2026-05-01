import { ResolveProfileForInboundService } from './resolve-profile-for-inbound.service';

const WS = '1bcbb4e0-df1b-481c-83ba-0730df47a720';
const TENANT = '38380c75-1876-4984-b194-5fda7529835c';
const OUR = '+16193303608';
const THEIR = '+19719982082';

function buildRepo() {
  return {
    findOne: jest.fn(),
  };
}

function buildService() {
  const conversationRepo = buildRepo();
  const tpnRepo = buildRepo();
  const ppaRepo = buildRepo();
  const service = new ResolveProfileForInboundService(
    conversationRepo as any,
    tpnRepo as any,
    ppaRepo as any,
  );
  return { service, conversationRepo, tpnRepo, ppaRepo };
}

describe('ResolveProfileForInboundService', () => {
  it('returns sticky when an existing conversation has a profile_id', async () => {
    const { service, conversationRepo, tpnRepo, ppaRepo } = buildService();
    conversationRepo.findOne.mockResolvedValue({
      communicationProfileId: 'prof-1',
      communicationBusinessId: 'biz-1',
    });

    const r = await service.resolve({
      workspaceId: WS,
      tenantId: TENANT,
      ourPhone: OUR,
      theirPhone: THEIR,
    });

    expect(r).toEqual({
      profileId: 'prof-1',
      businessId: 'biz-1',
      confidence: 'sticky',
    });
    // sticky path doesn't query phone fallback
    expect(tpnRepo.findOne).not.toHaveBeenCalled();
    expect(ppaRepo.findOne).not.toHaveBeenCalled();
  });

  it('falls back to phone_default when no sticky conversation', async () => {
    const { service, conversationRepo, tpnRepo, ppaRepo } = buildService();
    conversationRepo.findOne.mockResolvedValue(null);
    tpnRepo.findOne.mockResolvedValue({ id: 'tpn-1' });
    ppaRepo.findOne.mockResolvedValue({
      profileId: 'prof-2',
      profile: { communicationBusinessId: 'biz-2' },
    });

    const r = await service.resolve({
      workspaceId: WS,
      tenantId: TENANT,
      ourPhone: OUR,
      theirPhone: THEIR,
    });

    expect(r).toEqual({
      profileId: 'prof-2',
      businessId: 'biz-2',
      confidence: 'phone_default',
    });
    expect(ppaRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantPhoneNumberId: 'tpn-1', active: true },
        order: { isDefault: 'DESC', priority: 'DESC' },
      }),
    );
  });

  it('falls back to phone_default ignoring sticky rows that have no profile_id', async () => {
    // Pre-PR1 conversations have communicationProfileId IS NULL; we treat
    // that the same as "no sticky" and continue to the phone fallback.
    const { service, conversationRepo, tpnRepo, ppaRepo } = buildService();
    conversationRepo.findOne.mockResolvedValue({
      communicationProfileId: null,
      communicationBusinessId: null,
    });
    tpnRepo.findOne.mockResolvedValue({ id: 'tpn-1' });
    ppaRepo.findOne.mockResolvedValue({
      profileId: 'prof-2',
      profile: { communicationBusinessId: 'biz-2' },
    });

    const r = await service.resolve({
      workspaceId: WS,
      tenantId: TENANT,
      ourPhone: OUR,
      theirPhone: THEIR,
    });
    expect(r.confidence).toBe('phone_default');
    expect(r.profileId).toBe('prof-2');
  });

  it('returns unknown when neither path matches', async () => {
    const { service, conversationRepo, tpnRepo } = buildService();
    conversationRepo.findOne.mockResolvedValue(null);
    tpnRepo.findOne.mockResolvedValue(null);

    const r = await service.resolve({
      workspaceId: WS,
      tenantId: TENANT,
      ourPhone: OUR,
      theirPhone: THEIR,
    });

    expect(r).toEqual({ profileId: null, businessId: null, confidence: 'unknown' });
  });

  it('returns unknown when phone exists but no active assignment matches', async () => {
    const { service, conversationRepo, tpnRepo, ppaRepo } = buildService();
    conversationRepo.findOne.mockResolvedValue(null);
    tpnRepo.findOne.mockResolvedValue({ id: 'tpn-1' });
    ppaRepo.findOne.mockResolvedValue(null);

    const r = await service.resolve({
      workspaceId: WS,
      tenantId: TENANT,
      ourPhone: OUR,
      theirPhone: THEIR,
    });
    expect(r.confidence).toBe('unknown');
    expect(r.profileId).toBeNull();
    expect(r.businessId).toBeNull();
  });

  it('orders the conversation lookup by created_at DESC (most recent wins)', async () => {
    const { service, conversationRepo } = buildService();
    conversationRepo.findOne.mockResolvedValue({
      communicationProfileId: 'prof-x',
      communicationBusinessId: 'biz-x',
    });
    await service.resolve({
      workspaceId: WS,
      tenantId: TENANT,
      ourPhone: OUR,
      theirPhone: THEIR,
    });
    expect(conversationRepo.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId: WS,
          tenantId: TENANT,
          phoneNumber: OUR,
          participantPhoneNumber: THEIR,
        },
        order: { createdAt: 'DESC' },
      }),
    );
  });
});
