import {
  AuditBusinessRow,
  AuditProfileRow,
  AuditTenantRow,
  businessLocationSignature,
  groupBusinessesForDuplicates,
  groupProfilesForDuplicates,
  groupTenantsForDuplicates,
  isAccountStubName,
  isPlatformAnchor,
  isZombieTenant,
  normalizeName,
  recommendTenantAction,
  selectCanonicalBusiness,
  selectCanonicalProfile,
  selectCanonicalTenant,
  tenantSignature,
} from './audit-duplicates.helpers';

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

  it('never selects an anchor tenant', () => {
    const anchor = makeTenant({ id: 't-anchor', name: 'LeadBridge' });
    const zombie = makeTenant({
      id: 't-zombie',
      name: 'Spotless Homes Tampa',
      conversationCount: 5,
      latestActivityAt: new Date(),
    });
    // Group of [anchor, zombie] — zombie has positive score from activity,
    // so zombie wins (not the anchor).
    expect(selectCanonicalTenant([anchor, zombie])).toBe('t-zombie');
  });

  it('returns null when every candidate is dead', () => {
    const z1 = makeTenant({ id: 't-1', hasSavedAccount: false });
    const z2 = makeTenant({ id: 't-2', hasSavedAccount: false });
    expect(selectCanonicalTenant([z1, z2])).toBeNull();
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

describe('groupTenantsForDuplicates', () => {
  it('groups by lb_user_id when present', () => {
    const lbMap = new Map([
      ['t1', 'lb-user-X'],
      ['t2', 'lb-user-X'],
      ['t3', 'lb-user-Y'],
    ]);
    const tenants = [
      makeTenant({ id: 't1' }),
      makeTenant({ id: 't2' }),
      makeTenant({ id: 't3' }),
    ];
    const groups = groupTenantsForDuplicates(tenants, lbMap);
    expect(groups.get('lb-user:lb-user-X')?.length).toBe(2);
    expect(groups.get('lb-user:lb-user-Y')?.length).toBe(1);
  });

  it('groups same-named zombies under name signature', () => {
    const zombies = [
      makeTenant({ id: 't1', name: 'Spotless Homes Tampa' }),
      makeTenant({ id: 't2', name: 'spotless homes tampa' }), // different case
      makeTenant({ id: 't3', name: 'Spotless Homes Tampa' }),
    ];
    const groups = groupTenantsForDuplicates(zombies, new Map());
    expect(groups.get('name:spotless homes tampa')?.length).toBe(3);
  });

  it('puts auto-stub Account <uuid> tenants in singleton orphan groups', () => {
    const stubs = [
      makeTenant({ id: 't1', name: 'Account abcd1234-...' }),
      makeTenant({ id: 't2', name: 'Account 999fffff-...' }),
    ];
    const groups = groupTenantsForDuplicates(stubs, new Map());
    expect(groups.get('orphan:t1')?.length).toBe(1);
    expect(groups.get('orphan:t2')?.length).toBe(1);
  });

  it('puts anchors in their own anchor-prefixed group', () => {
    const anchor = makeTenant({ id: 't-a', name: 'LeadBridge' });
    const groups = groupTenantsForDuplicates([anchor], new Map());
    expect(groups.get('anchor:leadbridge')?.length).toBe(1);
  });

  it('lb-user signature wins over name when both apply', () => {
    const t = makeTenant({ id: 't1', name: 'Spotless Homes Tampa' });
    const lbMap = new Map([['t1', 'lb-user-X']]);
    expect(tenantSignature(t, lbMap)).toBe('lb-user:lb-user-X');
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
