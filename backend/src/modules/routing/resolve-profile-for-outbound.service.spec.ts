import { ResolveProfileForOutboundService } from './resolve-profile-for-outbound.service';
import { RoutingError, RoutingErrorCode } from './routing-errors';

const TENANT = 'tenant-aaaa';
const OTHER_TENANT = 'tenant-bbbb';
const PROFILE_ID = 'prof-1234';
const BUSINESS_ID = 'biz-9999';

function buildRepo() {
  return {
    findOne: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
}

/**
 * Builds a chainable QueryBuilder mock that resolves to `rows` when
 * `getRawMany()` is called. All chain methods return the same instance.
 */
function makeQB(rows: any[]) {
  const qb: any = {};
  ['innerJoin', 'where', 'andWhere', 'select', 'orderBy', 'addOrderBy'].forEach(
    (method) => (qb[method] = jest.fn(() => qb)),
  );
  qb.getRawMany = jest.fn(async () => rows);
  return qb;
}

function buildService() {
  const profileRepo = buildRepo();
  const ppaRepo = buildRepo();
  const tpnRepo = buildRepo();
  const service = new ResolveProfileForOutboundService(
    profileRepo as any,
    ppaRepo as any,
    tpnRepo as any,
  );
  return { service, profileRepo, ppaRepo, tpnRepo };
}

describe('ResolveProfileForOutboundService — profileId path', () => {
  it('resolves to the profile default when fromNumber is omitted', async () => {
    const { service, profileRepo, ppaRepo } = buildService();
    profileRepo.findOne.mockResolvedValue({
      id: PROFILE_ID,
      tenantId: TENANT,
      communicationBusinessId: BUSINESS_ID,
    });
    ppaRepo.createQueryBuilder.mockReturnValue(
      makeQB([
        { ppa_id: 'a1', is_default: true, priority: 100, phone_number: '+15551111111' },
        { ppa_id: 'a2', is_default: false, priority: 50, phone_number: '+15552222222' },
      ]),
    );

    const r = await service.resolve({ tenantId: TENANT, profileId: PROFILE_ID });

    expect(r).toEqual({
      profileId: PROFILE_ID,
      businessId: BUSINESS_ID,
      fromNumber: '+15551111111',
      source: 'profile_explicit',
    });
  });

  it('honors caller-provided fromNumber when it belongs to the profile', async () => {
    const { service, profileRepo, ppaRepo } = buildService();
    profileRepo.findOne.mockResolvedValue({
      id: PROFILE_ID,
      tenantId: TENANT,
      communicationBusinessId: BUSINESS_ID,
    });
    ppaRepo.createQueryBuilder.mockReturnValue(
      makeQB([
        { ppa_id: 'a1', is_default: true, priority: 100, phone_number: '+15551111111' },
        { ppa_id: 'a2', is_default: false, priority: 50, phone_number: '+15552222222' },
      ]),
    );

    const r = await service.resolve({
      tenantId: TENANT,
      profileId: PROFILE_ID,
      fromNumber: '+15552222222',
    });

    expect(r).toEqual({
      profileId: PROFILE_ID,
      businessId: BUSINESS_ID,
      fromNumber: '+15552222222',
      source: 'profile_explicit_phone',
    });
  });

  it('throws CROSS_TENANT_PROFILE when profile.tenant_id mismatches', async () => {
    const { service, profileRepo } = buildService();
    profileRepo.findOne.mockResolvedValue({
      id: PROFILE_ID,
      tenantId: OTHER_TENANT,
      communicationBusinessId: BUSINESS_ID,
    });

    await expect(
      service.resolve({ tenantId: TENANT, profileId: PROFILE_ID }),
    ).rejects.toMatchObject({
      name: 'RoutingError',
      code: RoutingErrorCode.CROSS_TENANT_PROFILE,
    });
  });

  it('throws PROFILE_NOT_FOUND when profileId does not exist', async () => {
    const { service, profileRepo } = buildService();
    profileRepo.findOne.mockResolvedValue(null);
    await expect(
      service.resolve({ tenantId: TENANT, profileId: 'missing-uuid' }),
    ).rejects.toMatchObject({ code: RoutingErrorCode.PROFILE_NOT_FOUND });
  });

  it('throws PROFILE_NOT_CONFIGURED when profile has zero active assignments', async () => {
    const { service, profileRepo, ppaRepo } = buildService();
    profileRepo.findOne.mockResolvedValue({
      id: PROFILE_ID,
      tenantId: TENANT,
      communicationBusinessId: BUSINESS_ID,
    });
    ppaRepo.createQueryBuilder.mockReturnValue(makeQB([]));

    await expect(
      service.resolve({ tenantId: TENANT, profileId: PROFILE_ID }),
    ).rejects.toMatchObject({ code: RoutingErrorCode.PROFILE_NOT_CONFIGURED });
  });

  it('throws INVALID_PROFILE_PHONE when fromNumber is not in the profile set', async () => {
    const { service, profileRepo, ppaRepo } = buildService();
    profileRepo.findOne.mockResolvedValue({
      id: PROFILE_ID,
      tenantId: TENANT,
      communicationBusinessId: BUSINESS_ID,
    });
    ppaRepo.createQueryBuilder.mockReturnValue(
      makeQB([
        { ppa_id: 'a1', is_default: true, priority: 100, phone_number: '+15551111111' },
      ]),
    );

    await expect(
      service.resolve({
        tenantId: TENANT,
        profileId: PROFILE_ID,
        fromNumber: '+19999999999',
      }),
    ).rejects.toMatchObject({ code: RoutingErrorCode.INVALID_PROFILE_PHONE });
  });
});

describe('ResolveProfileForOutboundService — profileSlug path', () => {
  it('resolves a slug under the calling tenant', async () => {
    const { service, profileRepo, ppaRepo } = buildService();
    profileRepo.findOne.mockResolvedValue({
      id: PROFILE_ID,
      tenantId: TENANT,
      communicationBusinessId: BUSINESS_ID,
      slug: 'reminders',
    });
    ppaRepo.createQueryBuilder.mockReturnValue(
      makeQB([
        { ppa_id: 'a1', is_default: true, priority: 100, phone_number: '+15551111111' },
      ]),
    );

    const r = await service.resolve({ tenantId: TENANT, profileSlug: 'reminders' });
    expect(r.source).toBe('profile_slug');
    expect(r.fromNumber).toBe('+15551111111');
    expect(profileRepo.findOne).toHaveBeenCalledWith({
      where: { tenantId: TENANT, slug: 'reminders' },
    });
  });

  it('throws PROFILE_NOT_FOUND when slug does not match for this tenant', async () => {
    const { service, profileRepo } = buildService();
    profileRepo.findOne.mockResolvedValue(null);
    await expect(
      service.resolve({ tenantId: TENANT, profileSlug: 'nope' }),
    ).rejects.toMatchObject({ code: RoutingErrorCode.PROFILE_NOT_FOUND });
  });
});

describe('ResolveProfileForOutboundService — fromNumber-only path', () => {
  it('accepts fromNumber when exactly one profile owns it', async () => {
    const { service, ppaRepo } = buildService();
    ppaRepo.createQueryBuilder.mockReturnValue(
      makeQB([{ ppa_id: 'a1', profile_id: PROFILE_ID, business_id: BUSINESS_ID }]),
    );

    const r = await service.resolve({ tenantId: TENANT, fromNumber: '+15551111111' });
    expect(r).toEqual({
      profileId: PROFILE_ID,
      businessId: BUSINESS_ID,
      fromNumber: '+15551111111',
      source: 'phone_unique',
    });
  });

  it('throws AMBIGUOUS_FROM_NUMBER when the phone is shared by multiple profiles', async () => {
    const { service, ppaRepo } = buildService();
    ppaRepo.createQueryBuilder.mockReturnValue(
      makeQB([
        { ppa_id: 'a1', profile_id: 'p1', business_id: 'b1' },
        { ppa_id: 'a2', profile_id: 'p2', business_id: 'b1' },
      ]),
    );

    await expect(
      service.resolve({ tenantId: TENANT, fromNumber: '+15553334444' }),
    ).rejects.toMatchObject({ code: RoutingErrorCode.AMBIGUOUS_FROM_NUMBER });
  });

  it('throws INVALID_PROFILE_PHONE when the fromNumber has no assignment for this tenant', async () => {
    const { service, ppaRepo } = buildService();
    ppaRepo.createQueryBuilder.mockReturnValue(makeQB([]));
    await expect(
      service.resolve({ tenantId: TENANT, fromNumber: '+19998887777' }),
    ).rejects.toMatchObject({ code: RoutingErrorCode.INVALID_PROFILE_PHONE });
  });
});

describe('ResolveProfileForOutboundService — empty input', () => {
  it('throws AMBIGUOUS_FROM_NUMBER when no profileId / profileSlug / fromNumber is given', async () => {
    const { service } = buildService();
    await expect(
      service.resolve({ tenantId: TENANT }),
    ).rejects.toMatchObject({ code: RoutingErrorCode.AMBIGUOUS_FROM_NUMBER });
  });
});

describe('RoutingError', () => {
  it('exposes the error code on instances', () => {
    const e = new RoutingError(RoutingErrorCode.CROSS_TENANT_PROFILE, 'wrong tenant');
    expect(e.code).toBe('CROSS_TENANT_PROFILE');
    expect(e.message).toBe('wrong tenant');
    expect(e.name).toBe('RoutingError');
    expect(e).toBeInstanceOf(Error);
  });
});
