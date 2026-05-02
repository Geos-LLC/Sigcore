import {
  AuditBusinessRow,
  AuditProfileRow,
  AuditTenantRow,
  TenantSignatureInputs,
  businessLocationSignature,
  groupBusinessesForDuplicates,
  groupProfilesForDuplicates,
  groupTenantsBySignature,
  isAccountStubName,
  isPlatformAnchor,
  isZombieTenant,
  normalizeName,
  pickBestLocationFromBusinesses,
  pickBestSourceFromProfiles,
  recommendTenantAction,
  selectCanonicalBusiness,
  selectCanonicalProfile,
  selectCanonicalTenant,
  tenantSignature,
} from './audit-duplicates.helpers';

function makeSig(overrides: Partial<TenantSignatureInputs> = {}): TenantSignatureInputs {
  return {
    platformId: 'leadbridge',
    lbUserId: null,
    curatedLocation: null,
    fallbackLocationName: null,
    bestRealSource: null,
    defaultSource: 'leadbridge',
    ...overrides,
  };
}

function makeTenant(overrides: Partial<AuditTenantRow> = {}): AuditTenantRow {
  return {
    id: overrides.id ?? 't1',
    workspaceId: 'ws',
    externalId: null,
    name: null,
    status: 'active',
    hasSavedAccount: false,
    latestActivityAt: null,
    conversationCount: 0,
    apiKeyCount: 0,
    webhookSubscriptionCount: 0,
    endpointRouteCount: 0,
    phoneNumberCount: 0,
    ...overrides,
  };
}

function makeBusiness(overrides: Partial<AuditBusinessRow> = {}): AuditBusinessRow {
  return {
    id: overrides.id ?? 'b1',
    workspaceId: 'ws',
    tenantId: 't1',
    displayName: 'Test',
    slug: 'test',
    status: 'active',
    externalBusinessId: null,
    metadata: null,
    activePhoneAssignments: 0,
    profileCount: 0,
    ...overrides,
  };
}

function makeProfile(overrides: Partial<AuditProfileRow> = {}): AuditProfileRow {
  return {
    id: overrides.id ?? 'p1',
    communicationBusinessId: 'b1',
    tenantId: 't1',
    source: 'leadbridge',
    externalProfileId: null,
    displayName: 'Default',
    slug: 'default',
    isDefault: true,
    status: 'active',
    activePhoneAssignments: 0,
    ...overrides,
  };
}

describe('normalizeName', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normalizeName('  Spotless  Homes  Tampa  ')).toBe('spotless homes tampa');
  });
  it('strips punctuation', () => {
    expect(normalizeName('ABC, Inc.')).toBe('abc inc');
  });
  it('handles null/undefined', () => {
    expect(normalizeName(null)).toBe('');
    expect(normalizeName(undefined)).toBe('');
  });
});

describe('isAccountStubName', () => {
  it('detects auto-generated Account <uuid> stubs', () => {
    expect(isAccountStubName('Account 5b8a9ba9-de42-453f-85c4-a38ebb5ba4db')).toBe(true);
    expect(isAccountStubName('account abc12345')).toBe(true);
  });
  it('does NOT match real customer names', () => {
    expect(isAccountStubName('Spotless Homes Tampa')).toBe(false);
    expect(isAccountStubName('Account Manager Co')).toBe(false);
  });
});

describe('isPlatformAnchor', () => {
  it('detects anchor tenants by name', () => {
    expect(isPlatformAnchor(makeTenant({ name: 'LeadBridge' }))).toBe(true);
    expect(isPlatformAnchor(makeTenant({ name: 'Service Flow' }))).toBe(true);
    expect(isPlatformAnchor(makeTenant({ name: 'Callio' }))).toBe(true);
    expect(isPlatformAnchor(makeTenant({ name: 'HireFunnel' }))).toBe(true);
  });
  it('detects anchors by external_id pattern', () => {
    expect(isPlatformAnchor(makeTenant({ externalId: 'leadbridge-4xtm' }))).toBe(true);
  });
  it('rejects real customer tenants', () => {
    expect(isPlatformAnchor(makeTenant({ name: 'Spotless Homes Tampa' }))).toBe(false);
    expect(isPlatformAnchor(makeTenant({ name: 'Lavanda Cleaning' }))).toBe(false);
  });
});

describe('isZombieTenant', () => {
  it('zombie = no SavedAccount + not anchor', () => {
    expect(
      isZombieTenant(makeTenant({ name: 'Spotless Homes Tampa', hasSavedAccount: false })),
    ).toBe(true);
  });
  it('not zombie when has SavedAccount', () => {
    expect(isZombieTenant(makeTenant({ hasSavedAccount: true }))).toBe(false);
  });
  it('anchor is not a zombie', () => {
    expect(isZombieTenant(makeTenant({ name: 'LeadBridge' }))).toBe(false);
  });
});

describe('selectCanonicalTenant', () => {
  it('prefers SavedAccount-backed candidate', () => {
    const real = makeTenant({ id: 't-real', name: 'Spotless Homes Tampa', hasSavedAccount: true });
    const zombie = makeTenant({
      id: 't-zombie',
      name: 'Spotless Homes Tampa',
      hasSavedAccount: false,
    });
    expect(selectCanonicalTenant([zombie, real])).toBe('t-real');
  });

  it('breaks ties by phones, conversations, recent activity', () => {
    const a = makeTenant({ id: 't-a', hasSavedAccount: true, phoneNumberCount: 0 });
    const b = makeTenant({ id: 't-b', hasSavedAccount: true, phoneNumberCount: 1 });
    expect(selectCanonicalTenant([a, b])).toBe('t-b');
  });

  it('PR9.1: never selects an anchor or a zombie even with positive activity', () => {
    // Strict mode: only hasSavedAccount=true candidates are eligible.
    const anchor = makeTenant({ id: 't-anchor', name: 'LeadBridge' });
    const zombie = makeTenant({
      id: 't-zombie',
      name: 'Spotless Homes Tampa',
      hasSavedAccount: false,
      conversationCount: 50,
      latestActivityAt: new Date(),
    });
    expect(selectCanonicalTenant([anchor, zombie])).toBeNull();
  });

  it('PR9.1: returns null for zombie-only groups (no SavedAccount-backed candidate)', () => {
    const z1 = makeTenant({ id: 't-1', hasSavedAccount: false });
    const z2 = makeTenant({ id: 't-2', hasSavedAccount: false });
    expect(selectCanonicalTenant([z1, z2])).toBeNull();
  });

  it('PR9.1: real candidate wins even with weak signals when sibling is zombie', () => {
    const real = makeTenant({ id: 't-real', hasSavedAccount: true });
    const zombieWithTraffic = makeTenant({
      id: 't-zombie',
      hasSavedAccount: false,
      conversationCount: 1000,
    });
    expect(selectCanonicalTenant([real, zombieWithTraffic])).toBe('t-real');
  });

  it('deterministic on tie — sorts by id ascending', () => {
    const a = makeTenant({ id: 't-bbb', hasSavedAccount: true });
    const b = makeTenant({ id: 't-aaa', hasSavedAccount: true });
    expect(selectCanonicalTenant([a, b])).toBe('t-aaa');
  });
});

describe('recommendTenantAction', () => {
  it('canonical → keep_canonical', () => {
    const t = makeTenant({ id: 't-c', hasSavedAccount: true });
    const r = recommendTenantAction(t, t);
    expect(r.action).toBe('keep_canonical');
    expect(r.safeToDelete).toBe(false);
  });

  it('anchor → flag_anchor_tenant', () => {
    const anchor = makeTenant({ id: 't-anchor', name: 'LeadBridge' });
    const r = recommendTenantAction(anchor, null);
    expect(r.action).toBe('flag_anchor_tenant');
    expect(r.safeToDelete).toBe(false);
  });

  it('clean zombie (no traffic, no phones, no wiring) → deactivate_zombie + safe', () => {
    const zombie = makeTenant({ id: 't-zombie', hasSavedAccount: false });
    const r = recommendTenantAction(zombie, null);
    expect(r.action).toBe('deactivate_zombie');
    expect(r.safeToDelete).toBe(true);
  });

  it('zombie WITH traffic → manual_review (NOT safe)', () => {
    const zombie = makeTenant({
      id: 't-zombie',
      hasSavedAccount: false,
      conversationCount: 100,
    });
    const r = recommendTenantAction(zombie, null);
    expect(r.action).toBe('manual_review');
    expect(r.safeToDelete).toBe(false);
  });

  it('zombie WITH phone assignment → manual_review', () => {
    const zombie = makeTenant({
      id: 't-zombie',
      hasSavedAccount: false,
      phoneNumberCount: 1,
    });
    const r = recommendTenantAction(zombie, null);
    expect(r.action).toBe('manual_review');
  });

  it('real duplicate of canonical → soft_disable_duplicate', () => {
    const canonical = makeTenant({ id: 't-c', hasSavedAccount: true, phoneNumberCount: 1 });
    const dup = makeTenant({ id: 't-d', hasSavedAccount: true, phoneNumberCount: 0 });
    const r = recommendTenantAction(dup, canonical);
    expect(r.action).toBe('soft_disable_duplicate');
    expect(r.safeToDelete).toBe(true); // no traffic
  });

  it('real duplicate WITH traffic → soft_disable but NOT safe', () => {
    const canonical = makeTenant({ id: 't-c', hasSavedAccount: true });
    const dup = makeTenant({ id: 't-d', hasSavedAccount: true, conversationCount: 50 });
    const r = recommendTenantAction(dup, canonical);
    expect(r.action).toBe('soft_disable_duplicate');
    expect(r.safeToDelete).toBe(false);
  });
});

describe('tenantSignature (PR9.1 strict)', () => {
  it('builds a 4-part key for real LB tenants', () => {
    const t = makeTenant({ id: 't-real', name: 'Account ext-uuid', externalId: 'sa-uuid', hasSavedAccount: true });
    const sig = tenantSignature(
      t,
      makeSig({
        lbUserId: 'lb-user-spotless',
        curatedLocation: 'tampa',
        bestRealSource: 'thumbtack',
      }),
    );
    expect(sig).toBe('leadbridge|lb-user:lb-user-spotless|loc:tampa|src:thumbtack');
  });

  it('uses external_id customer key for tenants with no lb_user_id (zombies)', () => {
    const t = makeTenant({ id: 't-z', externalId: 'sa-zombie-uuid', name: 'Spotless Homes Tampa' });
    const sig = tenantSignature(
      t,
      makeSig({
        lbUserId: null,
        fallbackLocationName: 'Spotless Homes Tampa',
        defaultSource: 'leadbridge',
      }),
    );
    expect(sig).toBe('leadbridge|ext:sa-zombie-uuid|name:spotless homes tampa|src:leadbridge');
  });

  it('produces an anchor-prefixed signature for platform anchors (never collides with customers)', () => {
    const anchor = makeTenant({ id: 't-a', name: 'LeadBridge' });
    expect(tenantSignature(anchor, makeSig())).toMatch(/^anchor:/);
  });

  it('Spotless Homes Tampa TT and Spotless Homes Jacksonville TT do NOT collide', () => {
    const tampa = makeTenant({ id: 't-tampa', hasSavedAccount: true, externalId: 'sa-tampa-tt' });
    const jax = makeTenant({ id: 't-jax', hasSavedAccount: true, externalId: 'sa-jax-tt' });
    const sigTampa = tenantSignature(
      tampa,
      makeSig({ lbUserId: 'lb-user-spotless', curatedLocation: 'tampa', bestRealSource: 'thumbtack' }),
    );
    const sigJax = tenantSignature(
      jax,
      makeSig({ lbUserId: 'lb-user-spotless', curatedLocation: 'jacksonville', bestRealSource: 'thumbtack' }),
    );
    expect(sigTampa).not.toBe(sigJax);
  });

  it('Spotless Homes Tampa TT and Spotless Homes Tampa Yelp do NOT collide', () => {
    const tt = makeTenant({ id: 't-tt' });
    const yelp = makeTenant({ id: 't-yelp' });
    const sigTT = tenantSignature(
      tt,
      makeSig({ lbUserId: 'lb-user-spotless', curatedLocation: 'tampa', bestRealSource: 'thumbtack' }),
    );
    const sigYelp = tenantSignature(
      yelp,
      makeSig({ lbUserId: 'lb-user-spotless', curatedLocation: 'tampa', bestRealSource: 'yelp' }),
    );
    expect(sigTT).not.toBe(sigYelp);
  });

  it('Lavanda TT and Lavanda Yelp do NOT collide', () => {
    const tt = tenantSignature(
      makeTenant({ id: 't-tt' }),
      makeSig({
        lbUserId: 'lb-user-lavanda',
        fallbackLocationName: 'Lavanda Cleaning',
        bestRealSource: 'thumbtack',
      }),
    );
    const yelp = tenantSignature(
      makeTenant({ id: 't-yelp' }),
      makeSig({
        lbUserId: 'lb-user-lavanda',
        fallbackLocationName: 'Lavanda Cleaning',
        bestRealSource: 'yelp',
      }),
    );
    expect(tt).not.toBe(yelp);
  });

  it('two zombies with the same name but different external_ids do NOT collide (each is its own customer)', () => {
    const z1 = tenantSignature(
      makeTenant({ id: 't-z1', externalId: 'sa-z1', name: 'Spotless Homes Tampa' }),
      makeSig({ fallbackLocationName: 'Spotless Homes Tampa', defaultSource: 'leadbridge' }),
    );
    const z2 = tenantSignature(
      makeTenant({ id: 't-z2', externalId: 'sa-z2', name: 'Spotless Homes Tampa' }),
      makeSig({ fallbackLocationName: 'Spotless Homes Tampa', defaultSource: 'leadbridge' }),
    );
    expect(z1).not.toBe(z2);
  });

  it('zombie does NOT collide with real tenant for same location (different customer + source dimensions)', () => {
    const real = tenantSignature(
      makeTenant({ id: 't-real', hasSavedAccount: true }),
      makeSig({ lbUserId: 'lb-user-spotless', curatedLocation: 'tampa', bestRealSource: 'thumbtack' }),
    );
    const zombie = tenantSignature(
      makeTenant({ id: 't-zombie', externalId: 'sa-zombie' }),
      makeSig({ fallbackLocationName: 'Spotless Homes Tampa', defaultSource: 'leadbridge' }),
    );
    // ZOMBIE has different customer key (ext:sa-zombie vs lb-user:...) AND
    // different location key shape (name:... vs loc:...). They are not duplicates.
    expect(real).not.toBe(zombie);
  });
});

describe('pickBestLocationFromBusinesses', () => {
  it('prefers metadata.location over display name', () => {
    const out = pickBestLocationFromBusinesses([
      makeBusiness({ displayName: 'Spotless Homes Tampa', metadata: { location: 'tampa' } }),
    ]);
    expect(out.curated).toBe('tampa');
    expect(out.fallback).toBe('Spotless Homes Tampa');
  });
  it('falls back to display name when no metadata.location', () => {
    const out = pickBestLocationFromBusinesses([
      makeBusiness({ displayName: 'Lavanda Cleaning', metadata: null }),
    ]);
    expect(out.curated).toBeNull();
    expect(out.fallback).toBe('Lavanda Cleaning');
  });
});

describe('pickBestSourceFromProfiles', () => {
  it('prefers a real materialized source over the kept Default', () => {
    const out = pickBestSourceFromProfiles([
      makeProfile({ source: 'leadbridge', isDefault: true, slug: 'default' }),
      makeProfile({
        id: 'p-tt',
        source: 'thumbtack',
        isDefault: true,
        slug: 'thumbtack-tampa',
        externalProfileId: 'ext',
      }),
    ]);
    expect(out.real).toBe('thumbtack');
  });
  it('falls back to default source when no real source exists (zombie)', () => {
    const out = pickBestSourceFromProfiles([
      makeProfile({ source: 'leadbridge', isDefault: true }),
    ]);
    expect(out.real).toBeNull();
    expect(out.defaulted).toBe('leadbridge');
  });
});

describe('groupTenantsBySignature', () => {
  it('buckets tenants by precomputed signature', () => {
    const tenants = [
      makeTenant({ id: 't1' }),
      makeTenant({ id: 't2' }),
      makeTenant({ id: 't3' }),
    ];
    const sigs = new Map([
      ['t1', 'sig-a'],
      ['t2', 'sig-a'],
      ['t3', 'sig-b'],
    ]);
    const groups = groupTenantsBySignature(tenants, sigs);
    expect(groups.get('sig-a')?.length).toBe(2);
    expect(groups.get('sig-b')?.length).toBe(1);
  });

  it('skips tenants with no signature', () => {
    const tenants = [makeTenant({ id: 't1' }), makeTenant({ id: 't2' })];
    const sigs = new Map([['t1', 'sig-a']]);
    const groups = groupTenantsBySignature(tenants, sigs);
    expect(groups.get('sig-a')?.length).toBe(1);
    expect(groups.size).toBe(1);
  });
});

describe('recommendTenantAction (PR9.1 group-aware)', () => {
  it('multi-record group with no canonical → manual_review (zombie-only group rule)', () => {
    const z = makeTenant({ id: 't-z', hasSavedAccount: false });
    const r = recommendTenantAction(z, null, 3);
    expect(r.action).toBe('manual_review');
    expect(r.safeToDelete).toBe(false);
    expect(r.reason).toMatch(/no SavedAccount-backed canonical/);
  });

  it('singleton clean zombie still → deactivate_zombie (groupSize=1)', () => {
    const z = makeTenant({ id: 't-z', hasSavedAccount: false });
    const r = recommendTenantAction(z, null, 1);
    expect(r.action).toBe('deactivate_zombie');
  });

  it('multi-record group with real canonical, zombie sibling has wiring → manual_review', () => {
    const canonical = makeTenant({ id: 't-c', hasSavedAccount: true });
    const zombieWithWiring = makeTenant({
      id: 't-z',
      hasSavedAccount: false,
      phoneNumberCount: 1,
    });
    const r = recommendTenantAction(zombieWithWiring, canonical, 2);
    expect(r.action).toBe('manual_review');
  });
});

describe('businessLocationSignature', () => {
  it('uses metadata.location when present', () => {
    expect(
      businessLocationSignature(
        makeBusiness({ displayName: 'Spotless Homes Tampa', metadata: { location: 'tampa' } }),
      ),
    ).toBe('loc:tampa');
  });
  it('falls back to normalized display_name', () => {
    expect(
      businessLocationSignature(
        makeBusiness({ displayName: 'Spotless Homes Tampa', metadata: null }),
      ),
    ).toBe('name:spotless homes tampa');
  });
});

describe('groupBusinessesForDuplicates', () => {
  it('keeps same-location businesses under same workspace as one group', () => {
    const wsMap = new Map([
      ['b1', 'lb-user-X'],
      ['b2', 'lb-user-X'],
      ['b3', 'lb-user-X'],
    ]);
    const businesses = [
      makeBusiness({ id: 'b1', metadata: { location: 'tampa' } }),
      makeBusiness({ id: 'b2', metadata: { location: 'tampa' } }),
      makeBusiness({ id: 'b3', metadata: { location: 'jacksonville' } }),
    ];
    const groups = groupBusinessesForDuplicates(businesses, wsMap);
    expect(groups.get('lb-user-X::loc:tampa')?.length).toBe(2);
    expect(groups.get('lb-user-X::loc:jacksonville')?.length).toBe(1);
  });
});

describe('selectCanonicalBusiness', () => {
  it('prefers business with externalBusinessId set', () => {
    const a = makeBusiness({ id: 'b-a', externalBusinessId: null });
    const b = makeBusiness({ id: 'b-b', externalBusinessId: 'sa-uuid' });
    expect(selectCanonicalBusiness([a, b])).toBe('b-b');
  });
  it('breaks ties by active phone assignments', () => {
    const a = makeBusiness({ id: 'b-a', externalBusinessId: 'x', activePhoneAssignments: 0 });
    const b = makeBusiness({ id: 'b-b', externalBusinessId: 'x', activePhoneAssignments: 3 });
    expect(selectCanonicalBusiness([a, b])).toBe('b-b');
  });
});

describe('groupProfilesForDuplicates', () => {
  it('groups profiles by (business, source, external_id)', () => {
    const profiles = [
      makeProfile({ id: 'p1', communicationBusinessId: 'b1', source: 'thumbtack', externalProfileId: 'ext-1' }),
      makeProfile({ id: 'p2', communicationBusinessId: 'b1', source: 'thumbtack', externalProfileId: 'ext-1' }),
      makeProfile({ id: 'p3', communicationBusinessId: 'b1', source: 'yelp', externalProfileId: 'ext-2' }),
    ];
    const groups = groupProfilesForDuplicates(profiles);
    expect(groups.get('b1::thumbtack::ext-1')?.length).toBe(2);
    expect(groups.get('b1::yelp::ext-2')?.length).toBe(1);
  });

  it('treats null external_id as a separate bucket per business+source', () => {
    const p1 = makeProfile({ id: 'p1', communicationBusinessId: 'b1', source: 'leadbridge', externalProfileId: null });
    const p2 = makeProfile({ id: 'p2', communicationBusinessId: 'b1', source: 'leadbridge', externalProfileId: null });
    const groups = groupProfilesForDuplicates([p1, p2]);
    expect(groups.get('b1::leadbridge::<null>')?.length).toBe(2);
  });
});

describe('selectCanonicalProfile', () => {
  it('prefers profile with externalProfileId over null', () => {
    const a = makeProfile({ id: 'p-a', externalProfileId: null, isDefault: false });
    const b = makeProfile({ id: 'p-b', externalProfileId: 'ext-1', isDefault: false });
    expect(selectCanonicalProfile([a, b])).toBe('p-b');
  });
  it('among duplicates of same source/external_id, prefers is_default=true', () => {
    const a = makeProfile({ id: 'p-a', externalProfileId: null, isDefault: false });
    const b = makeProfile({ id: 'p-b', externalProfileId: null, isDefault: true });
    expect(selectCanonicalProfile([a, b])).toBe('p-b');
  });
});
