import {
  AggregationBusiness,
  AggregationPhoneCounts,
  AggregationProfileCounts,
  AggregationTenant,
  aggregateWorkspaces,
  pickLbCustomerDisplayName,
  workspaceKeyForBusiness,
} from './workspace-aggregation';

const T_TT_TAMPA = 't-tt-tampa';
const T_YELP_TAMPA = 't-yelp-tampa';
const T_TT_JAX = 't-tt-jax';
const T_LAVANDA = 't-lavanda';
const T_HF = 't-hirefunnel';

const LB_USER_SPOTLESS = 'lb-user-spotless-id';
const LB_USER_LAVANDA = 'lb-user-lavanda-id';

const TENANTS: AggregationTenant[] = [
  { id: T_TT_TAMPA, name: 'Account 38380c75', workspaceId: 'ws', platformId: 'leadbridge' },
  { id: T_YELP_TAMPA, name: 'Account af78105f', workspaceId: 'ws', platformId: 'leadbridge' },
  { id: T_TT_JAX, name: 'Account 6a4eeca9', workspaceId: 'ws', platformId: 'leadbridge' },
  { id: T_LAVANDA, name: 'Account 38380c75', workspaceId: 'ws', platformId: 'leadbridge' },
  { id: T_HF, name: 'HireFunnel', workspaceId: 'ws', platformId: 'hirefunnel' },
];

const BUSINESSES: AggregationBusiness[] = [
  {
    id: 'b-tt-tampa',
    tenantId: T_TT_TAMPA,
    workspaceId: 'ws',
    displayName: 'Spotless Homes Tampa',
    metadata: { lb_user_id: LB_USER_SPOTLESS, location: 'tampa' },
  },
  {
    id: 'b-yelp-tampa',
    tenantId: T_YELP_TAMPA,
    workspaceId: 'ws',
    displayName: 'Spotless Homes Tampa',
    metadata: { lb_user_id: LB_USER_SPOTLESS, location: 'tampa' },
  },
  {
    id: 'b-tt-jax',
    tenantId: T_TT_JAX,
    workspaceId: 'ws',
    displayName: 'Spotless Homes Jacksonville',
    metadata: { lb_user_id: LB_USER_SPOTLESS, location: 'jacksonville' },
  },
  {
    id: 'b-lavanda',
    tenantId: T_LAVANDA,
    workspaceId: 'ws',
    displayName: 'Lavanda Cleaning',
    metadata: { lb_user_id: LB_USER_LAVANDA, location: 'lavanda-cleaning' },
  },
  {
    id: 'b-hf',
    tenantId: T_HF,
    workspaceId: 'ws',
    displayName: 'HireFunnel',
    metadata: null,
  },
];

const EMPTY_PROFILE_COUNTS: AggregationProfileCounts = {
  byProfileId: new Map(),
  realProfilesPerBusiness: new Map([
    ['b-tt-tampa', 1],
    ['b-yelp-tampa', 1],
    ['b-tt-jax', 1],
    ['b-lavanda', 1],
  ]),
  allProfilesPerBusiness: new Map(),
};

const EMPTY_PHONE_COUNTS: AggregationPhoneCounts = {
  phonesPerBusiness: new Map([
    ['b-tt-tampa', new Set(['+1FL_TAMPA'])],
    ['b-yelp-tampa', new Set(['+1FL_TAMPA'])], // shared with TT Tampa
    ['b-tt-jax', new Set(['+1FL_JAX'])],
    ['b-lavanda', new Set(['+1LAV'])],
  ]),
};

describe('workspaceKeyForBusiness', () => {
  it('uses lb-user prefix when metadata.lb_user_id is set', () => {
    expect(
      workspaceKeyForBusiness({
        tenantId: 't1',
        metadata: { lb_user_id: 'u-abc' } as Record<string, unknown>,
      }),
    ).toBe('lb-user-u-abc');
  });

  it('falls back to tenant key when metadata is missing', () => {
    expect(workspaceKeyForBusiness({ tenantId: 't1', metadata: null as any })).toBe(
      'tenant-t1',
    );
  });

  it('falls back to tenant key when lb_user_id is empty/whitespace', () => {
    expect(
      workspaceKeyForBusiness({
        tenantId: 't1',
        metadata: { lb_user_id: '  ' } as Record<string, unknown>,
      }),
    ).toBe('tenant-t1');
  });
});

describe('pickLbCustomerDisplayName', () => {
  it('prefers operator override metadata.workspace_display_name', () => {
    expect(
      pickLbCustomerDisplayName([
        {
          id: 'b1',
          tenantId: 't1',
          workspaceId: 'ws',
          displayName: 'Spotless Homes Tampa',
          metadata: { workspace_display_name: 'Spotless Homes' },
        },
      ]),
    ).toBe('Spotless Homes');
  });

  it('picks the shortest spaced name as the brand', () => {
    expect(
      pickLbCustomerDisplayName([
        {
          id: 'b1',
          tenantId: 't1',
          workspaceId: 'ws',
          displayName: 'Spotless Homes Saint Petersburg',
          metadata: null,
        },
        {
          id: 'b2',
          tenantId: 't2',
          workspaceId: 'ws',
          displayName: 'Spotless Homes Tampa',
          metadata: null,
        },
        {
          id: 'b3',
          tenantId: 't3',
          workspaceId: 'ws',
          displayName: 'Spotless Homes',
          metadata: null,
        },
      ]),
    ).toBe('Spotless Homes');
  });

  it('returns the only available name when there is just one business', () => {
    expect(
      pickLbCustomerDisplayName([
        {
          id: 'b',
          tenantId: 't',
          workspaceId: 'ws',
          displayName: 'Lavanda Cleaning',
          metadata: null,
        },
      ]),
    ).toBe('Lavanda Cleaning');
  });

  it('returns Unknown for an empty input', () => {
    expect(pickLbCustomerDisplayName([])).toBe('Unknown');
  });
});

describe('aggregateWorkspaces', () => {
  it('collapses all LB-Spotless tenants into one workspace row', () => {
    const out = aggregateWorkspaces(
      TENANTS,
      BUSINESSES,
      EMPTY_PROFILE_COUNTS,
      EMPTY_PHONE_COUNTS,
    );
    const spotless = out.find((w) => w.lbUserId === LB_USER_SPOTLESS);
    expect(spotless).toBeDefined();
    expect(spotless!.kind).toBe('lb_customer');
    expect(spotless!.key).toBe(`lb-user-${LB_USER_SPOTLESS}`);
    expect(spotless!.tenantIds.sort()).toEqual([T_TT_JAX, T_TT_TAMPA, T_YELP_TAMPA].sort());
    expect(spotless!.businessCount).toBe(3);
    expect(spotless!.profileCount).toBe(3);
    expect(spotless!.platformId).toBe('leadbridge');
  });

  it('Lavanda becomes its own LB customer workspace', () => {
    const out = aggregateWorkspaces(
      TENANTS,
      BUSINESSES,
      EMPTY_PROFILE_COUNTS,
      EMPTY_PHONE_COUNTS,
    );
    const lavanda = out.find((w) => w.lbUserId === LB_USER_LAVANDA);
    expect(lavanda).toBeDefined();
    expect(lavanda!.kind).toBe('lb_customer');
    expect(lavanda!.tenantIds).toEqual([T_LAVANDA]);
    expect(lavanda!.businessCount).toBe(1);
    expect(lavanda!.profileCount).toBe(1);
  });

  it('non-LB tenants get one row per tenant', () => {
    const out = aggregateWorkspaces(
      TENANTS,
      BUSINESSES,
      EMPTY_PROFILE_COUNTS,
      EMPTY_PHONE_COUNTS,
    );
    const hf = out.find((w) => w.tenantIds.includes(T_HF));
    expect(hf).toBeDefined();
    expect(hf!.kind).toBe('tenant');
    expect(hf!.lbUserId).toBeNull();
    expect(hf!.platformId).toBe('hirefunnel');
    expect(hf!.key).toBe(`tenant-${T_HF}`);
  });

  it('phone count dedupes shared phones across businesses in same workspace', () => {
    const out = aggregateWorkspaces(
      TENANTS,
      BUSINESSES,
      EMPTY_PROFILE_COUNTS,
      EMPTY_PHONE_COUNTS,
    );
    const spotless = out.find((w) => w.lbUserId === LB_USER_SPOTLESS);
    // TT Tampa + Yelp Tampa share +1FL_TAMPA; TT Jax has +1FL_JAX. Total distinct = 2.
    expect(spotless!.phoneCount).toBe(2);
  });

  it('output is sorted by displayName asc', () => {
    const out = aggregateWorkspaces(
      TENANTS,
      BUSINESSES,
      EMPTY_PROFILE_COUNTS,
      EMPTY_PHONE_COUNTS,
    );
    const names = out.map((w) => w.displayName);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  it('a tenant with no businesses still appears as a solo workspace', () => {
    const tenants: AggregationTenant[] = [
      { id: 't-orphan', name: 'OrphanCo', workspaceId: 'ws', platformId: 'unclassified' },
    ];
    const out = aggregateWorkspaces(
      tenants,
      [],
      { byProfileId: new Map(), realProfilesPerBusiness: new Map(), allProfilesPerBusiness: new Map() },
      { phonesPerBusiness: new Map() },
    );
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('tenant');
    expect(out[0].displayName).toBe('OrphanCo');
    expect(out[0].businessCount).toBe(0);
  });

  it('skips orphan businesses pointing at non-existent tenants', () => {
    const orphanBiz: AggregationBusiness = {
      id: 'b-orphan',
      tenantId: 't-does-not-exist',
      workspaceId: 'ws',
      displayName: 'Orphan',
      metadata: null,
    };
    const out = aggregateWorkspaces(
      TENANTS,
      [...BUSINESSES, orphanBiz],
      EMPTY_PROFILE_COUNTS,
      EMPTY_PHONE_COUNTS,
    );
    // No "Orphan" workspace surfaced.
    expect(out.find((w) => w.displayName === 'Orphan')).toBeUndefined();
  });
});
