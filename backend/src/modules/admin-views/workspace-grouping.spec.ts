import {
  groupWorkspaces,
  GroupingTenant,
  GroupingBusiness,
} from './workspace-grouping';

function tenant(over: Partial<GroupingTenant> & Pick<GroupingTenant, 'id' | 'name'>): GroupingTenant {
  return {
    businessIdentityId: null,
    attributionReason: 'unclassified',
    phoneNumbersCount: 0,
    hasLegacy: false,
    hasCurrent: false,
    ...over,
  };
}

const NO_BUSINESSES = new Map<string, GroupingBusiness>();

describe('groupWorkspaces — empty', () => {
  it('returns no groups for an empty input', () => {
    expect(groupWorkspaces([], NO_BUSINESSES).groups).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 1. business_identity_id grouping (highest priority)
// ---------------------------------------------------------------------------
describe('groupWorkspaces — Rule 1: business_identity_id', () => {
  it('groups multiple tenants pointing at the same business under one workspace', () => {
    const businesses = new Map<string, GroupingBusiness>([
      ['biz-spotless', { id: 'biz-spotless', name: 'Spotless Homes Florida LLC' }],
    ]);
    const result = groupWorkspaces(
      [
        tenant({ id: 't1', name: 'Spotless Homes Tampa', businessIdentityId: 'biz-spotless', phoneNumbersCount: 1, hasCurrent: true }),
        tenant({ id: 't2', name: 'Spotless Homes Jacksonville', businessIdentityId: 'biz-spotless', phoneNumbersCount: 0, hasLegacy: true }),
      ],
      businesses,
    );
    expect(result.groups).toHaveLength(1);
    const g = result.groups[0];
    expect(g.name).toBe('Spotless Homes Florida LLC');
    expect(g.source).toBe('business_identity');
    expect(g.businessIdentityId).toBe('biz-spotless');
    expect(g.profiles.map((p) => p.name).sort()).toEqual([
      'Spotless Homes Jacksonville',
      'Spotless Homes Tampa',
    ]);
    expect(g.totalTenantCount).toBe(2);
    expect(g.totalPhoneNumbersCount).toBe(1);
  });

  it('falls back to a placeholder when business is missing from the map', () => {
    const result = groupWorkspaces(
      [tenant({ id: 't1', name: 'Customer X', businessIdentityId: 'biz-orphan-1234567890' })],
      new Map(),
    );
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].name).toMatch(/^\(business biz-orph/);
    expect(result.groups[0].source).toBe('business_identity');
  });

  it('separates tenants with different business_identity_ids', () => {
    const businesses = new Map<string, GroupingBusiness>([
      ['biz-a', { id: 'biz-a', name: 'Customer A' }],
      ['biz-b', { id: 'biz-b', name: 'Customer B' }],
    ]);
    const result = groupWorkspaces(
      [
        tenant({ id: 't1', name: 'X', businessIdentityId: 'biz-a' }),
        tenant({ id: 't2', name: 'Y', businessIdentityId: 'biz-b' }),
      ],
      businesses,
    );
    expect(result.groups).toHaveLength(2);
    expect(result.groups.map((g) => g.name).sort()).toEqual(['Customer A', 'Customer B']);
  });
});

// ---------------------------------------------------------------------------
// 2. Name prefix fallback
// ---------------------------------------------------------------------------
describe('groupWorkspaces — Rule 2: name prefix', () => {
  it('groups Spotless Homes by city as separate profiles', () => {
    const result = groupWorkspaces(
      [
        tenant({ id: 't1', name: 'Spotless Homes Tampa' }),
        tenant({ id: 't2', name: 'Spotless Homes Jacksonville' }),
        tenant({ id: 't3', name: 'Spotless Homes Saint Petersburg' }),
      ],
      NO_BUSINESSES,
    );
    expect(result.groups).toHaveLength(1);
    const g = result.groups[0];
    expect(g.name).toBe('Spotless Homes');
    expect(g.source).toBe('name_prefix');
    expect(g.businessIdentityId).toBeNull();
    expect(g.profiles.map((p) => p.name).sort()).toEqual([
      'Jacksonville',
      'Saint Petersburg',
      'Tampa',
    ]);
  });

  it('matches all six canonical prefixes case-insensitively', () => {
    const result = groupWorkspaces(
      [
        tenant({ id: 's1', name: 'Spotless Homes Tampa' }),
        tenant({ id: 'n1', name: 'NatashaHome cleaning' }),
        tenant({ id: 'l1', name: 'Lavanda Cleaning' }),
        tenant({ id: 'a1', name: 'ABC Solutions - Always Best Cleaning' }),
        tenant({ id: 's2', name: 'Scandinavian cleaning LLC' }),
        tenant({ id: 'b1', name: 'Brilliant Clean Home Boca' }),
      ],
      NO_BUSINESSES,
    );
    const names = result.groups.map((g) => g.name).sort();
    expect(names).toEqual([
      'ABC Solutions',
      'Brilliant Clean Home',
      'Lavanda Cleaning',
      'NatashaHome',
      'Scandinavian cleaning',
      'Spotless Homes',
    ]);
  });

  it('strips leading separators from profile remainder', () => {
    const result = groupWorkspaces(
      [tenant({ id: 't1', name: 'ABC Solutions - Always Best Cleaning' })],
      NO_BUSINESSES,
    );
    const g = result.groups[0];
    expect(g.name).toBe('ABC Solutions');
    expect(g.profiles[0].name).toBe('Always Best Cleaning');
  });

  it('uses the canonical workspace name as profile name when remainder is empty', () => {
    const result = groupWorkspaces(
      [tenant({ id: 't1', name: 'Lavanda Cleaning' })],
      NO_BUSINESSES,
    );
    const g = result.groups[0];
    expect(g.name).toBe('Lavanda Cleaning');
    expect(g.profiles).toHaveLength(1);
    expect(g.profiles[0].name).toBe('Lavanda Cleaning');
    expect(g.profiles[0].duplicateCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Standalone fallback
// ---------------------------------------------------------------------------
describe('groupWorkspaces — Rule 3: standalone', () => {
  it('treats unrecognised tenants as their own workspace + only profile', () => {
    const result = groupWorkspaces(
      [
        tenant({ id: 't1', name: 'Account fa4a8d5b-…' }),
        tenant({ id: 't2', name: 'Georgiy Sayapin' }),
      ],
      NO_BUSINESSES,
    );
    expect(result.groups).toHaveLength(2);
    for (const g of result.groups) {
      expect(g.source).toBe('standalone');
      expect(g.profiles).toHaveLength(1);
      expect(g.profiles[0].duplicateCount).toBe(1);
    }
  });

  it('handles empty / null tenant names gracefully', () => {
    const result = groupWorkspaces(
      [tenant({ id: 'abc12345-aaaa', name: '' as any })],
      NO_BUSINESSES,
    );
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].source).toBe('standalone');
    expect(result.groups[0].name).toMatch(/^\(unnamed abc12345/);
  });
});

// ---------------------------------------------------------------------------
// 4. Duplicate collapsing
// ---------------------------------------------------------------------------
describe('groupWorkspaces — duplicate collapsing', () => {
  it('collapses 4 "Spotless Homes Tampa" tenants into a single profile', () => {
    const result = groupWorkspaces(
      [
        tenant({ id: 't1', name: 'Spotless Homes Tampa', phoneNumbersCount: 1, hasCurrent: true }),
        tenant({ id: 't2', name: 'Spotless Homes Tampa', phoneNumbersCount: 0, hasLegacy: true }),
        tenant({ id: 't3', name: 'Spotless Homes Tampa' }),
        tenant({ id: 't4', name: 'Spotless Homes Tampa' }),
      ],
      NO_BUSINESSES,
    );
    expect(result.groups).toHaveLength(1);
    const g = result.groups[0];
    expect(g.profiles).toHaveLength(1);
    const profile = g.profiles[0];
    expect(profile.name).toBe('Tampa');
    expect(profile.duplicateCount).toBe(4);
    expect(profile.tenantIds).toEqual(['t1', 't2', 't3', 't4']);
    expect(profile.phoneNumbersCount).toBe(1);
    expect(profile.hasLegacy).toBe(true);
    expect(profile.hasCurrent).toBe(true);
  });

  it('keeps separate profiles for different cities under the same workspace', () => {
    const result = groupWorkspaces(
      [
        tenant({ id: 't1', name: 'Spotless Homes Tampa' }),
        tenant({ id: 't2', name: 'Spotless Homes Tampa' }),
        tenant({ id: 't3', name: 'Spotless Homes Jacksonville' }),
      ],
      NO_BUSINESSES,
    );
    const g = result.groups[0];
    expect(g.profiles).toHaveLength(2);
    expect(g.profiles.find((p) => p.name === 'Tampa')!.duplicateCount).toBe(2);
    expect(g.profiles.find((p) => p.name === 'Jacksonville')!.duplicateCount).toBe(1);
    expect(g.totalTenantCount).toBe(3);
  });

  it('aggregates attributionReasons across duplicates', () => {
    const result = groupWorkspaces(
      [
        tenant({ id: 't1', name: 'Spotless Homes Tampa', attributionReason: 'webhook_url:thumbtack-bridge' }),
        tenant({ id: 't2', name: 'Spotless Homes Tampa', attributionReason: 'api_key_name:leadbridge' }),
        tenant({ id: 't3', name: 'Spotless Homes Tampa', attributionReason: 'api_key_name:leadbridge' }),
      ],
      NO_BUSINESSES,
    );
    const profile = result.groups[0].profiles[0];
    expect(profile.attributionReasons.sort()).toEqual([
      'api_key_name:leadbridge',
      'webhook_url:thumbtack-bridge',
    ]);
    expect(result.groups[0].attributionReasons.sort()).toEqual([
      'api_key_name:leadbridge',
      'webhook_url:thumbtack-bridge',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 5. Mixed-case names
// ---------------------------------------------------------------------------
describe('groupWorkspaces — mixed-case dedup', () => {
  it('case-folds NatashaHome cleaning + NatashaHome Cleaning into one profile', () => {
    const result = groupWorkspaces(
      [
        tenant({ id: 't1', name: 'NatashaHome cleaning' }),
        tenant({ id: 't2', name: 'NatashaHome cleaning' }),
        tenant({ id: 't3', name: 'NatashaHome Cleaning' }),
        tenant({ id: 't4', name: 'NatashaHome Cleaning' }),
      ],
      NO_BUSINESSES,
    );
    expect(result.groups).toHaveLength(1);
    const g = result.groups[0];
    expect(g.name).toBe('NatashaHome');
    expect(g.profiles).toHaveLength(1);
    expect(g.profiles[0].duplicateCount).toBe(4);
    expect(g.profiles[0].tenantIds).toEqual(['t1', 't2', 't3', 't4']);
  });

  it('preserves casing of the first contributing tenant in profile name', () => {
    const a = groupWorkspaces(
      [
        tenant({ id: 't1', name: 'NatashaHome cleaning' }), // first → "cleaning"
        tenant({ id: 't2', name: 'NatashaHome Cleaning' }),
      ],
      NO_BUSINESSES,
    );
    expect(a.groups[0].profiles[0].name).toBe('cleaning');

    const b = groupWorkspaces(
      [
        tenant({ id: 't1', name: 'NatashaHome Cleaning' }), // first → "Cleaning"
        tenant({ id: 't2', name: 'NatashaHome cleaning' }),
      ],
      NO_BUSINESSES,
    );
    expect(b.groups[0].profiles[0].name).toBe('Cleaning');
  });
});

// ---------------------------------------------------------------------------
// 6. Real-world prod fixture
// ---------------------------------------------------------------------------
describe('groupWorkspaces — real-world fixture (workspace 1bcbb4e0…)', () => {
  it('produces ~Spotless×1, NatashaHome×1, Lavanda×1, ABC×1, Scandinavian×1, plus 23 standalone Account workspaces', () => {
    const tenants: GroupingTenant[] = [
      // 8 Spotless tenants across 3 cities, with dups
      tenant({ id: 'sp1', name: 'Spotless Homes Tampa' }),
      tenant({ id: 'sp2', name: 'Spotless Homes Tampa' }),
      tenant({ id: 'sp3', name: 'Spotless Homes Tampa' }),
      tenant({ id: 'sp4', name: 'Spotless Homes Tampa' }),
      tenant({ id: 'sp5', name: 'Spotless Homes Jacksonville' }),
      tenant({ id: 'sp6', name: 'Spotless Homes Jacksonville' }),
      tenant({ id: 'sp7', name: 'Spotless Homes Saint Petersburg' }),
      tenant({ id: 'sp8', name: 'Spotless Homes Saint Petersburg' }),
      // 4 NatashaHome (mixed case)
      tenant({ id: 'nh1', name: 'NatashaHome cleaning' }),
      tenant({ id: 'nh2', name: 'NatashaHome cleaning' }),
      tenant({ id: 'nh3', name: 'NatashaHome Cleaning' }),
      tenant({ id: 'nh4', name: 'NatashaHome Cleaning' }),
      // singletons
      tenant({ id: 'lv', name: 'Lavanda Cleaning' }),
      tenant({ id: 'sc', name: 'Scandinavian cleaning LLC' }),
      tenant({ id: 'abc', name: 'ABC Solutions - Always Best Cleaning' }),
      // 5 Georgiy Sayapin (test rows — each standalone with same name)
      tenant({ id: 'gs1', name: 'Georgiy Sayapin' }),
      tenant({ id: 'gs2', name: 'Georgiy Sayapin' }),
      tenant({ id: 'gs3', name: 'Georgiy Sayapin' }),
      tenant({ id: 'gs4', name: 'Georgiy Sayapin' }),
      tenant({ id: 'gs5', name: 'Georgiy Sayapin' }),
      // 3 unique Account rows
      tenant({ id: 'ac1', name: 'Account fa4a8d5b-bf63-4b17-8249-d0178ce610aa' }),
      tenant({ id: 'ac2', name: 'Account 027fafe3-dffa-46c4-b03c-afd775d6fd12' }),
      tenant({ id: 'ac3', name: 'Account 39b7de47-69bd-4eda-a212-acf594a93a19' }),
    ];
    const result = groupWorkspaces(tenants, NO_BUSINESSES);

    const byName = new Map(result.groups.map((g) => [g.name, g]));

    // Spotless
    const spotless = byName.get('Spotless Homes')!;
    expect(spotless.source).toBe('name_prefix');
    expect(spotless.profileCount).toBe(3); // Tampa, Jacksonville, Saint Petersburg
    expect(spotless.totalTenantCount).toBe(8);
    expect(spotless.profiles.find((p) => p.name === 'Tampa')!.duplicateCount).toBe(4);
    expect(spotless.profiles.find((p) => p.name === 'Jacksonville')!.duplicateCount).toBe(2);
    expect(spotless.profiles.find((p) => p.name === 'Saint Petersburg')!.duplicateCount).toBe(2);

    // NatashaHome — 4 dups → 1 profile
    const natasha = byName.get('NatashaHome')!;
    expect(natasha.source).toBe('name_prefix');
    expect(natasha.profileCount).toBe(1);
    expect(natasha.profiles[0].duplicateCount).toBe(4);

    // Singletons
    expect(byName.get('Lavanda Cleaning')!.profileCount).toBe(1);
    expect(byName.get('Scandinavian cleaning')!.profileCount).toBe(1);
    expect(byName.get('ABC Solutions')!.profileCount).toBe(1);
    expect(byName.get('ABC Solutions')!.profiles[0].name).toBe('Always Best Cleaning');

    // Georgiy Sayapin — 5 standalone with same name → 5 separate workspaces (each its own row)
    const georgiyGroups = result.groups.filter((g) => g.name === 'Georgiy Sayapin');
    expect(georgiyGroups).toHaveLength(5);
    for (const g of georgiyGroups) expect(g.source).toBe('standalone');

    // Account rows — 3 distinct standalone workspaces
    const accountGroups = result.groups.filter((g) => g.name.startsWith('Account '));
    expect(accountGroups).toHaveLength(3);
    for (const g of accountGroups) expect(g.source).toBe('standalone');
  });
});

// ---------------------------------------------------------------------------
// 7. Source priority (business_identity wins over prefix)
// ---------------------------------------------------------------------------
describe('groupWorkspaces — priority order', () => {
  it('business_identity wins over name_prefix even when prefix would also match', () => {
    const businesses = new Map<string, GroupingBusiness>([
      ['biz-1', { id: 'biz-1', name: 'Spotless Homes Florida LLC' }],
    ]);
    const result = groupWorkspaces(
      [
        tenant({ id: 't1', name: 'Spotless Homes Tampa', businessIdentityId: 'biz-1' }),
        tenant({ id: 't2', name: 'Spotless Homes Jacksonville' }), // prefix match
      ],
      businesses,
    );
    expect(result.groups).toHaveLength(2); // separate workspaces by source
    const bi = result.groups.find((g) => g.source === 'business_identity')!;
    const np = result.groups.find((g) => g.source === 'name_prefix')!;
    expect(bi.name).toBe('Spotless Homes Florida LLC');
    expect(np.name).toBe('Spotless Homes');
    expect(bi.profiles[0].tenantIds).toEqual(['t1']);
    expect(np.profiles[0].tenantIds).toEqual(['t2']);
  });
});
