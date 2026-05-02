import {
  businessIsVisible,
  classifyBusiness,
  classifyProfile,
  classifyWorkspace,
  isAnchorByNameOrExternalId,
  profileIsVisible,
  workspaceIsVisible,
} from './classification';

describe('isAnchorByNameOrExternalId', () => {
  it('detects anchor names case/whitespace insensitive', () => {
    expect(isAnchorByNameOrExternalId({ name: 'LeadBridge' })).toBe(true);
    expect(isAnchorByNameOrExternalId({ name: '  service flow  ' })).toBe(true);
    expect(isAnchorByNameOrExternalId({ name: 'HireFunnel' })).toBe(true);
    expect(isAnchorByNameOrExternalId({ name: 'Callio' })).toBe(true);
  });
  it('detects anchor-prefixed external_ids', () => {
    expect(isAnchorByNameOrExternalId({ externalId: 'leadbridge-4xtm' })).toBe(true);
    expect(isAnchorByNameOrExternalId({ externalId: 'callio_test' })).toBe(true);
  });
  it('rejects real customer signals', () => {
    expect(isAnchorByNameOrExternalId({ name: 'Spotless Homes Tampa' })).toBe(false);
    expect(isAnchorByNameOrExternalId({ externalId: 'sa-uuid' })).toBe(false);
  });
});

describe('classifyWorkspace', () => {
  it('lb_customer kind → real_customer', () => {
    expect(
      classifyWorkspace({
        kind: 'lb_customer',
        platformId: 'leadbridge',
        displayName: 'Spotless Homes',
      }),
    ).toBe('real_customer');
  });

  it('non-LB tenant (hirefunnel/serviceflow/callio) → real_customer', () => {
    for (const platformId of ['hirefunnel', 'serviceflow', 'callio']) {
      expect(
        classifyWorkspace({
          kind: 'tenant',
          platformId,
          displayName: 'Customer Co',
        }),
      ).toBe('real_customer');
    }
  });

  it('LB tenant kind without lb_user_id metadata → zombie', () => {
    expect(
      classifyWorkspace({
        kind: 'tenant',
        platformId: 'leadbridge',
        displayName: 'Account abc12345-1111-2222',
      }),
    ).toBe('zombie');
  });

  it('unclassified tenant → zombie', () => {
    expect(
      classifyWorkspace({
        kind: 'tenant',
        platformId: 'unclassified',
        displayName: 'Mystery',
      }),
    ).toBe('zombie');
  });

  it('anchor name takes precedence over kind', () => {
    expect(
      classifyWorkspace({
        kind: 'tenant',
        platformId: 'leadbridge',
        displayName: 'LeadBridge',
      }),
    ).toBe('anchor');
  });

  it('anchor external_id takes precedence', () => {
    expect(
      classifyWorkspace({
        kind: 'lb_customer',
        platformId: 'leadbridge',
        displayName: 'Customer Co',
        tenantExternalId: 'leadbridge-4xtm',
      }),
    ).toBe('anchor');
  });
});

describe('classifyBusiness', () => {
  it('has lb_user_id → real', () => {
    expect(
      classifyBusiness({
        lbUserId: 'lb-user-spotless',
        externalBusinessId: null,
        platformId: 'leadbridge',
      }),
    ).toBe('real');
  });
  it('has external_business_id but no lb_user_id → real', () => {
    expect(
      classifyBusiness({
        lbUserId: null,
        externalBusinessId: 'sa-uuid',
        platformId: 'leadbridge',
      }),
    ).toBe('real');
  });
  it('non-LB platform tenant business → real (direct customer)', () => {
    expect(
      classifyBusiness({
        lbUserId: null,
        externalBusinessId: null,
        platformId: 'hirefunnel',
      }),
    ).toBe('real');
  });
  it('LB business with no PR6 metadata + no external id → zombie', () => {
    expect(
      classifyBusiness({
        lbUserId: null,
        externalBusinessId: null,
        platformId: 'leadbridge',
      }),
    ).toBe('zombie');
  });
  it('unclassified business → zombie', () => {
    expect(
      classifyBusiness({
        lbUserId: null,
        externalBusinessId: null,
        platformId: 'unclassified',
      }),
    ).toBe('zombie');
  });
});

describe('classifyProfile', () => {
  it('thumbtack/yelp/facebook source → real_source', () => {
    for (const source of ['thumbtack', 'yelp', 'facebook', 'craigslist', 'indeed']) {
      expect(
        classifyProfile({
          source,
          slug: 'thumbtack-tampa',
          isDefault: true,
          parentBusinessClassification: 'real',
        }),
      ).toBe('real_source');
    }
  });

  it('PR6 demoted default (slug=default, is_default=false) → kept_default', () => {
    expect(
      classifyProfile({
        source: 'leadbridge',
        slug: 'default',
        isDefault: false,
        parentBusinessClassification: 'real',
      }),
    ).toBe('kept_default');
  });

  it('default under zombie business → zombie_default', () => {
    expect(
      classifyProfile({
        source: 'leadbridge',
        slug: 'default',
        isDefault: true,
        parentBusinessClassification: 'zombie',
      }),
    ).toBe('zombie_default');
  });

  it('active default under real business → real_source (surface as primary)', () => {
    expect(
      classifyProfile({
        source: 'leadbridge',
        slug: 'default',
        isDefault: true,
        parentBusinessClassification: 'real',
      }),
    ).toBe('real_source');
  });
});

describe('workspaceIsVisible', () => {
  it('real_customer always visible', () => {
    expect(workspaceIsVisible('real_customer', {})).toBe(true);
  });
  it('zombie hidden by default; visible when includeZombies=true', () => {
    expect(workspaceIsVisible('zombie', {})).toBe(false);
    expect(workspaceIsVisible('zombie', { includeZombies: true })).toBe(true);
  });
  it('anchor hidden by default; visible when includeAnchors=true', () => {
    expect(workspaceIsVisible('anchor', {})).toBe(false);
    expect(workspaceIsVisible('anchor', { includeAnchors: true })).toBe(true);
  });
});

describe('businessIsVisible', () => {
  it('real always visible', () => {
    expect(businessIsVisible('real', {})).toBe(true);
  });
  it('zombie hidden by default', () => {
    expect(businessIsVisible('zombie', {})).toBe(false);
    expect(businessIsVisible('zombie', { includeZombies: true })).toBe(true);
  });
});

describe('profileIsVisible', () => {
  it('real_source always visible', () => {
    expect(profileIsVisible('real_source', {})).toBe(true);
  });
  it('kept_default hidden by default; visible with showRawDefaults', () => {
    expect(profileIsVisible('kept_default', {})).toBe(false);
    expect(profileIsVisible('kept_default', { showRawDefaults: true })).toBe(true);
  });
  it('zombie_default revealed by either showRawDefaults or includeZombies', () => {
    expect(profileIsVisible('zombie_default', {})).toBe(false);
    expect(profileIsVisible('zombie_default', { showRawDefaults: true })).toBe(true);
    expect(profileIsVisible('zombie_default', { includeZombies: true })).toBe(true);
  });
});
