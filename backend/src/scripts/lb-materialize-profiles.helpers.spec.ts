import {
  LbSavedAccount,
  LocationMap,
  TenantInput,
  ValidationIssue,
  evaluateValidationGate,
  normalizePlatform,
  parseLocation,
  planForTenant,
  platformDisplay,
  slugifyLocation,
  validateTenantSavedAccountAlignment,
} from './lb-materialize-profiles.helpers';

const SA_TT_TAMPA: LbSavedAccount = {
  id: 'sa_tt_tampa',
  userId: 'u_spotless',
  platform: 'thumbtack',
  businessId: 'tt_biz_tampa',
  businessName: 'Spotless Homes Tampa',
  userName: 'Spotless Homes',
};

const SA_YELP_JAX: LbSavedAccount = {
  id: 'sa_yelp_jax',
  userId: 'u_spotless',
  platform: 'yelp',
  businessId: 'yelp_biz_jax',
  businessName: 'Spotless Homes Jacksonville',
  userName: 'Spotless Homes',
};

const SA_LAVANDA_TT: LbSavedAccount = {
  id: 'sa_lav_tt',
  userId: 'u_lavanda',
  platform: 'thumbtack',
  businessId: 'tt_biz_lav',
  businessName: 'Lavanda Cleaning',
  userName: 'Lavanda Cleaning',
};

function makeTenantInput(overrides: Partial<TenantInput> = {}): TenantInput {
  return {
    tenantId: 't1',
    workspaceId: 'ws1',
    tenantExternalId: SA_TT_TAMPA.id,
    tenantName: `Account ${SA_TT_TAMPA.id}`,
    businessId: 'biz1',
    businessDisplayName: 'Account sa_tt_tampa',
    businessMetadata: null,
    defaultProfileId: 'p_default',
    defaultProfileSource: 'leadbridge',
    defaultProfileSlug: 'default',
    defaultProfileExternalId: null,
    activePhoneAssignmentIds: ['ppa1'],
    savedAccount: SA_TT_TAMPA,
    ...overrides,
  };
}

describe('slugifyLocation', () => {
  it('lowercases and kebab-cases', () => {
    expect(slugifyLocation('Saint Petersburg')).toBe('saint-petersburg');
    expect(slugifyLocation('St. Pete, FL')).toBe('st-pete-fl');
  });

  it('strips leading/trailing separators', () => {
    expect(slugifyLocation('  --Tampa--  ')).toBe('tampa');
  });

  it('falls back to "unknown" for empty input', () => {
    expect(slugifyLocation('')).toBe('unknown');
    expect(slugifyLocation(null)).toBe('unknown');
    expect(slugifyLocation(undefined)).toBe('unknown');
    expect(slugifyLocation('   ')).toBe('unknown');
  });
});

describe('normalizePlatform', () => {
  it('accepts thumbtack and yelp case-insensitively', () => {
    expect(normalizePlatform('thumbtack')).toBe('thumbtack');
    expect(normalizePlatform(' Thumbtack ')).toBe('thumbtack');
    expect(normalizePlatform('YELP')).toBe('yelp');
  });

  it('rejects everything else', () => {
    expect(normalizePlatform('facebook')).toBeNull();
    expect(normalizePlatform('')).toBeNull();
    expect(normalizePlatform(null)).toBeNull();
  });
});

describe('platformDisplay', () => {
  it('title-cases the platform value', () => {
    expect(platformDisplay('thumbtack')).toBe('Thumbtack');
    expect(platformDisplay('yelp')).toBe('Yelp');
  });
});

describe('parseLocation', () => {
  it('uses the curated map when present', () => {
    const map: LocationMap = {
      [SA_TT_TAMPA.id]: { locationKey: 'tampa', locationDisplay: 'Tampa' },
    };
    const out = parseLocation(SA_TT_TAMPA, map);
    expect(out).toEqual({ key: 'tampa', display: 'Tampa', source: 'curated' });
  });

  it('normalizes curated keys via slugifyLocation', () => {
    const map: LocationMap = {
      [SA_TT_TAMPA.id]: {
        locationKey: 'Saint Petersburg',
        locationDisplay: 'Saint Petersburg',
      },
    };
    const out = parseLocation(SA_TT_TAMPA, map);
    expect(out.key).toBe('saint-petersburg');
    expect(out.display).toBe('Saint Petersburg');
    expect(out.source).toBe('curated');
  });

  it('suffix-strips when businessName starts with userName', () => {
    const out = parseLocation(SA_YELP_JAX, null);
    expect(out).toEqual({
      key: 'jacksonville',
      display: 'Jacksonville',
      source: 'suffix_strip',
    });
  });

  it('suffix-strip handles separator characters between brand and location', () => {
    const out = parseLocation(
      {
        ...SA_TT_TAMPA,
        businessName: 'Spotless Homes - Saint Petersburg',
        userName: 'Spotless Homes',
      },
      null,
    );
    expect(out.key).toBe('saint-petersburg');
    expect(out.source).toBe('suffix_strip');
  });

  it('falls back to brand when businessName equals userName (single-location)', () => {
    const out = parseLocation(SA_LAVANDA_TT, null);
    expect(out).toEqual({
      key: 'lavanda-cleaning',
      display: 'Lavanda Cleaning',
      source: 'brand_fallback',
    });
  });

  it('falls back to brand when userName is missing', () => {
    const out = parseLocation(
      { ...SA_TT_TAMPA, userName: null },
      null,
    );
    expect(out.source).toBe('brand_fallback');
    expect(out.display).toBe('Spotless Homes Tampa');
  });

  it('curated map wins over suffix-strip', () => {
    const map: LocationMap = {
      [SA_YELP_JAX.id]: { locationKey: 'jax', locationDisplay: 'Jax' },
    };
    const out = parseLocation(SA_YELP_JAX, map);
    expect(out).toEqual({ key: 'jax', display: 'Jax', source: 'curated' });
  });
});

describe('planForTenant', () => {
  it('builds an apply plan for a valid Thumbtack tenant', () => {
    const plan = planForTenant(makeTenantInput(), null);
    expect(plan.kind).toBe('apply');
    if (plan.kind !== 'apply') return;
    expect(plan.newProfile).toEqual({
      platform: 'thumbtack',
      externalProfileId: 'tt_biz_tampa',
      displayName: 'Thumbtack Tampa',
      slug: 'thumbtack-tampa',
      savedAccountId: 'sa_tt_tampa',
    });
    expect(plan.businessUpdate.newDisplayName).toBe('Spotless Homes Tampa');
    expect(plan.businessUpdate.newMetadata).toMatchObject({
      location: 'tampa',
      location_display: 'Tampa',
      location_source: 'suffix_strip',
      lb_user_id: 'u_spotless',
      lb_saved_account_id: 'sa_tt_tampa',
    });
    expect(plan.phoneAssignmentIdsToMove).toEqual(['ppa1']);
  });

  it('skips when tenant.external_id does not match SavedAccount.id', () => {
    const plan = planForTenant(
      makeTenantInput({ tenantExternalId: 'mismatch' }),
      null,
    );
    expect(plan.kind).toBe('skip');
    if (plan.kind !== 'skip') return;
    expect(plan.reason).toBe('tenant_external_id_mismatch');
  });

  it('skips when platform is not thumbtack/yelp', () => {
    const plan = planForTenant(
      makeTenantInput({
        savedAccount: { ...SA_TT_TAMPA, platform: 'facebook' },
      }),
      null,
    );
    expect(plan.kind).toBe('skip');
    if (plan.kind !== 'skip') return;
    expect(plan.reason).toBe('unsupported_platform');
  });

  it('skips when SavedAccount.businessId is empty', () => {
    const plan = planForTenant(
      makeTenantInput({
        savedAccount: { ...SA_TT_TAMPA, businessId: '   ' },
      }),
      null,
    );
    expect(plan.kind).toBe('skip');
    if (plan.kind !== 'skip') return;
    expect(plan.reason).toBe('unsupported_platform');
  });

  it('preserves existing business metadata while merging new fields', () => {
    const plan = planForTenant(
      makeTenantInput({
        businessMetadata: { provisioned_via: 'leadbridge', custom_flag: true },
      }),
      null,
    );
    if (plan.kind !== 'apply') throw new Error('expected apply');
    expect(plan.businessUpdate.newMetadata).toMatchObject({
      provisioned_via: 'leadbridge',
      custom_flag: true,
      location: 'tampa',
      lb_saved_account_id: 'sa_tt_tampa',
    });
  });

  it('emits empty phone-move list when there are no active assignments', () => {
    const plan = planForTenant(
      makeTenantInput({ activePhoneAssignmentIds: [] }),
      null,
    );
    if (plan.kind !== 'apply') throw new Error('expected apply');
    expect(plan.phoneAssignmentIdsToMove).toEqual([]);
  });

  it('handles single-location case with brand fallback (Lavanda)', () => {
    const plan = planForTenant(
      makeTenantInput({
        tenantExternalId: SA_LAVANDA_TT.id,
        savedAccount: SA_LAVANDA_TT,
      }),
      null,
    );
    if (plan.kind !== 'apply') throw new Error('expected apply');
    expect(plan.newProfile.slug).toBe('thumbtack-lavanda-cleaning');
    expect(plan.newProfile.displayName).toBe('Thumbtack Lavanda Cleaning');
    expect(plan.location.source).toBe('brand_fallback');
  });
});

describe('validateTenantSavedAccountAlignment', () => {
  const map = new Map<string, LbSavedAccount>([
    [SA_TT_TAMPA.id, SA_TT_TAMPA],
    [SA_YELP_JAX.id, SA_YELP_JAX],
  ]);

  it('returns ok=true when every tenant has a matching SavedAccount with a supported platform', () => {
    const r = validateTenantSavedAccountAlignment(
      [
        { tenantId: 't1', tenantExternalId: SA_TT_TAMPA.id },
        { tenantId: 't2', tenantExternalId: SA_YELP_JAX.id },
      ],
      map,
    );
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('flags missing SavedAccount', () => {
    const r = validateTenantSavedAccountAlignment(
      [{ tenantId: 't1', tenantExternalId: 'nonexistent' }],
      map,
    );
    expect(r.ok).toBe(false);
    expect(r.issues[0].reason).toBe('no_saved_account_for_external_id');
  });

  it('flags null tenant.external_id', () => {
    const r = validateTenantSavedAccountAlignment(
      [{ tenantId: 't1', tenantExternalId: null }],
      map,
    );
    expect(r.ok).toBe(false);
    expect(r.issues[0].reason).toBe('no_saved_account_for_external_id');
  });

  it('flags unsupported platform', () => {
    const badMap = new Map<string, LbSavedAccount>([
      ['sa_fb', { ...SA_TT_TAMPA, id: 'sa_fb', platform: 'facebook' }],
    ]);
    const r = validateTenantSavedAccountAlignment(
      [{ tenantId: 't1', tenantExternalId: 'sa_fb' }],
      badMap,
    );
    expect(r.ok).toBe(false);
    expect(r.issues[0].reason).toBe('unsupported_platform_in_saved_account');
  });
});

// ---------------------------------------------------------------------------
// evaluateValidationGate
//
// The gate is the single source of truth for "should we proceed?". The
// executable script delegates to it twice (main check + tripwire) so the
// branching stays simple and testable.
// ---------------------------------------------------------------------------

const ORPHAN: ValidationIssue = {
  tenantId: 't_orphan',
  tenantExternalId: 'missing-uuid',
  reason: 'no_saved_account_for_external_id',
  detail: 'no LB SavedAccount with id=missing-uuid',
};
const HARD: ValidationIssue = {
  tenantId: 't_bad_platform',
  tenantExternalId: 'sa_fb',
  reason: 'unsupported_platform_in_saved_account',
  detail: 'platform="facebook"',
};

describe('evaluateValidationGate', () => {
  it('proceeds when there are no issues at all', () => {
    const r = evaluateValidationGate({
      validation: { ok: true, issues: [] },
      dryRun: false,
      allowOrphanTenants: false,
    });
    expect(r.decision).toBe('proceed');
    expect(r.reason).toBe('no_issues');
    expect(r.orphans).toEqual([]);
    expect(r.hardIssues).toEqual([]);
  });

  it('proceeds in dry-run regardless of issues (preview-only mode)', () => {
    const r = evaluateValidationGate({
      validation: { ok: false, issues: [ORPHAN, HARD] },
      dryRun: true,
      allowOrphanTenants: false,
    });
    expect(r.decision).toBe('proceed');
    expect(r.reason).toBe('dry_run_preview');
    expect(r.orphans).toEqual([ORPHAN]);
    expect(r.hardIssues).toEqual([HARD]);
  });

  describe('without --allow-orphan-tenants', () => {
    it('aborts live run when only orphan issues are present', () => {
      const r = evaluateValidationGate({
        validation: { ok: false, issues: [ORPHAN, ORPHAN, ORPHAN] },
        dryRun: false,
        allowOrphanTenants: false,
      });
      expect(r.decision).toBe('abort');
      expect(r.reason).toBe('orphans_not_allowed');
      expect(r.orphans).toHaveLength(3);
      expect(r.hardIssues).toEqual([]);
    });
  });

  describe('with --allow-orphan-tenants', () => {
    it('proceeds in live run when only orphan issues are present', () => {
      const r = evaluateValidationGate({
        validation: { ok: false, issues: [ORPHAN, ORPHAN] },
        dryRun: false,
        allowOrphanTenants: true,
      });
      expect(r.decision).toBe('proceed');
      expect(r.reason).toBe('orphans_allowed');
      expect(r.orphans).toHaveLength(2);
      expect(r.hardIssues).toEqual([]);
    });

    it('still aborts live run when ANY hard validation issue is present', () => {
      const r = evaluateValidationGate({
        validation: { ok: false, issues: [ORPHAN, HARD] },
        dryRun: false,
        allowOrphanTenants: true,
      });
      expect(r.decision).toBe('abort');
      expect(r.reason).toBe('hard_issues_present');
      expect(r.orphans).toEqual([ORPHAN]);
      expect(r.hardIssues).toEqual([HARD]);
    });

    it('aborts live run on hard-issue-only sets too', () => {
      const r = evaluateValidationGate({
        validation: { ok: false, issues: [HARD] },
        dryRun: false,
        allowOrphanTenants: true,
      });
      expect(r.decision).toBe('abort');
      expect(r.reason).toBe('hard_issues_present');
    });
  });
});
