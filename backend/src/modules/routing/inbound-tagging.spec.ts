import { ResolveProfileForInboundService } from './resolve-profile-for-inbound.service';

const WS = '1bcbb4e0';
const TENANT = 'tenant-1';
const SHARED_OUR = '+15551112222';
const THEIR_A = '+19991111111';
const THEIR_B = '+19992222222';

function buildRepo() {
  return { findOne: jest.fn(), save: jest.fn() };
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

/**
 * Higher-level scenario specs covering the inbound flow shown to webhook
 * code in PR3:
 *   - new conversation on a shared phone → phone-default profile written
 *   - reply on the same conversation → sticky (no phone-default lookup)
 *   - operator reassigned the profile → next reply preserves the new profile
 *
 * These exercise the resolveAndApplyToConversation contract directly,
 * since that's what the webhook services call.
 */
describe('ResolveProfileForInboundService — resolveAndApplyToConversation', () => {
  it('writes profile/business/confidence on a new conversation via phone_default', async () => {
    const { service, conversationRepo, tpnRepo, ppaRepo } = buildService();
    // No prior conversation on this (tenant, our, their) tuple
    conversationRepo.findOne.mockResolvedValue(null);
    tpnRepo.findOne.mockResolvedValue({ id: 'tpn-shared', tenantId: TENANT });
    ppaRepo.findOne.mockResolvedValue({
      profileId: 'profile-thumbtack',
      profile: { communicationBusinessId: 'biz-tampa' },
    });
    const conversationSave = conversationRepo.save;

    const conv: any = {
      id: 'conv-1',
      workspaceId: WS,
      tenantId: TENANT,
      phoneNumber: SHARED_OUR,
      participantPhoneNumber: THEIR_A,
      communicationProfileId: null,
      communicationBusinessId: null,
      profileConfidence: null,
    };

    const r = await service.resolveAndApplyToConversation(conv);

    expect(r).toEqual({
      tenantId: TENANT,
      profileId: 'profile-thumbtack',
      businessId: 'biz-tampa',
      confidence: 'phone_default',
    });
    expect(conv.communicationProfileId).toBe('profile-thumbtack');
    expect(conv.communicationBusinessId).toBe('biz-tampa');
    expect(conv.profileConfidence).toBe('phone_default');
    expect(conversationSave).toHaveBeenCalledWith(conv);
  });

  it('returns the existing profile (sticky) on a reply without re-querying the phone fallback', async () => {
    const { service, conversationRepo, tpnRepo, ppaRepo } = buildService();
    const conv: any = {
      id: 'conv-1',
      workspaceId: WS,
      tenantId: TENANT,
      phoneNumber: SHARED_OUR,
      participantPhoneNumber: THEIR_A,
      communicationProfileId: 'profile-thumbtack',
      communicationBusinessId: 'biz-tampa',
      profileConfidence: 'phone_default',
    };

    const r = await service.resolveAndApplyToConversation(conv);

    expect(r).toEqual({
      tenantId: TENANT,
      profileId: 'profile-thumbtack',
      businessId: 'biz-tampa',
      confidence: 'phone_default',
    });
    // No save (no change), no phone-fallback queries.
    expect(conversationRepo.save).not.toHaveBeenCalled();
    expect(tpnRepo.findOne).not.toHaveBeenCalled();
    expect(ppaRepo.findOne).not.toHaveBeenCalled();
  });

  it('preserves an operator-set profile id (no overwrite even if phone fallback would have picked a different one)', async () => {
    const { service, conversationRepo, tpnRepo, ppaRepo } = buildService();
    const conv: any = {
      id: 'conv-2',
      workspaceId: WS,
      tenantId: TENANT,
      phoneNumber: SHARED_OUR,
      participantPhoneNumber: THEIR_B,
      communicationProfileId: 'profile-yelp', // operator manually moved it from thumbtack to yelp
      communicationBusinessId: 'biz-tampa',
      profileConfidence: 'operator_set',
    };

    const r = await service.resolveAndApplyToConversation(conv);

    expect(r.profileId).toBe('profile-yelp');
    expect(r.confidence).toBe('operator_set');
    expect(conversationRepo.save).not.toHaveBeenCalled();
    expect(ppaRepo.findOne).not.toHaveBeenCalled();
  });

  it('two participants on the same shared phone get tagged independently via stickiness', async () => {
    const { service, conversationRepo, tpnRepo, ppaRepo } = buildService();
    // Participant A's conversation already has a sticky profile
    const convA: any = {
      id: 'convA',
      workspaceId: WS,
      tenantId: TENANT,
      phoneNumber: SHARED_OUR,
      participantPhoneNumber: THEIR_A,
      communicationProfileId: 'profile-thumbtack',
      communicationBusinessId: 'biz-tampa',
      profileConfidence: 'phone_default',
    };
    const rA = await service.resolveAndApplyToConversation(convA);
    expect(rA.profileId).toBe('profile-thumbtack');

    // Participant B's conversation is brand new → resolves via phone-default
    const convB: any = {
      id: 'convB',
      workspaceId: WS,
      tenantId: TENANT,
      phoneNumber: SHARED_OUR,
      participantPhoneNumber: THEIR_B,
      communicationProfileId: null,
      communicationBusinessId: null,
      profileConfidence: null,
    };
    conversationRepo.findOne.mockResolvedValue(null);
    tpnRepo.findOne.mockResolvedValue({ id: 'tpn-shared', tenantId: TENANT });
    ppaRepo.findOne.mockResolvedValue({
      profileId: 'profile-thumbtack',
      profile: { communicationBusinessId: 'biz-tampa' },
    });

    const rB = await service.resolveAndApplyToConversation(convB);
    expect(rB.profileId).toBe('profile-thumbtack');
    expect(rB.confidence).toBe('phone_default');
  });

  it('returns unknown without saving when neither tenant nor profile resolves', async () => {
    const { service, conversationRepo, tpnRepo } = buildService();
    conversationRepo.findOne.mockResolvedValue(null);
    tpnRepo.findOne.mockResolvedValue(null);

    const conv: any = {
      id: 'conv-x',
      workspaceId: WS,
      tenantId: null,
      phoneNumber: '+10000000000',
      participantPhoneNumber: '+19990000000',
      communicationProfileId: null,
      communicationBusinessId: null,
      profileConfidence: null,
    };
    const r = await service.resolveAndApplyToConversation(conv);

    expect(r).toEqual({
      tenantId: null,
      profileId: null,
      businessId: null,
      confidence: 'unknown',
    });
    expect(conv.communicationProfileId).toBeNull();
    expect(conversationRepo.save).not.toHaveBeenCalled();
  });

  it('backfills tenantId via tenant_phone_numbers when conversation.tenantId is null', async () => {
    const { service, conversationRepo, tpnRepo, ppaRepo } = buildService();
    conversationRepo.findOne.mockResolvedValue(null);
    tpnRepo.findOne.mockResolvedValue({ id: 'tpn-1', tenantId: TENANT });
    ppaRepo.findOne.mockResolvedValue({
      profileId: 'profile-x',
      profile: { communicationBusinessId: 'biz-x' },
    });

    const conv: any = {
      id: 'conv-pre-tenant',
      workspaceId: WS,
      tenantId: null,
      phoneNumber: SHARED_OUR,
      participantPhoneNumber: THEIR_A,
      communicationProfileId: null,
      communicationBusinessId: null,
      profileConfidence: null,
    };
    const r = await service.resolveAndApplyToConversation(conv);

    expect(r.tenantId).toBe(TENANT);
    expect(r.profileId).toBe('profile-x');
    expect(conv.tenantId).toBe(TENANT);
    expect(conversationRepo.save).toHaveBeenCalledWith(conv);
  });
});
