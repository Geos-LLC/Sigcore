import {
  AuditReport,
  AuditReportTenantGroup,
  LiveTenantState,
  RepointResult,
  buildRepointPlans,
  formatRepointResultLine,
  validateRepointPair,
} from './cleanup-repoint-duplicates.helpers';

// ---------------------------------------------------------------------------
// Audit fixture builder
// ---------------------------------------------------------------------------

function makeGroup(
  signature: string,
  canonicalId: string | null,
  records: Array<{
    id: string;
    isCanonical: boolean;
    isAnchor?: boolean;
    isZombie?: boolean;
    reason?: string;
  }>,
): AuditReportTenantGroup {
  return {
    signature,
    size: records.length,
    canonicalId,
    records: records.map((r) => ({
      recordType: 'tenant',
      recordId: r.id,
      isCanonical: r.isCanonical,
      recommendedAction: r.isCanonical ? 'keep_canonical' : 'soft_disable_duplicate',
      safeToDelete: !r.isCanonical && !r.isAnchor,
      reason: r.reason ?? 'test',
      dimensions: {
        isAnchor: r.isAnchor ?? false,
        isZombie: r.isZombie ?? false,
      },
    })),
  };
}

function makeAudit(groups: AuditReportTenantGroup[]): AuditReport {
  return {
    generatedAt: '2026-05-02T10:00:00Z',
    tenantGroups: groups,
  };
}

// ---------------------------------------------------------------------------
// buildRepointPlans
// ---------------------------------------------------------------------------

describe('buildRepointPlans', () => {
  it('emits one plan per non-canonical record in a multi-record group', () => {
    const audit = makeAudit([
      makeGroup('lb-user:U1', 't-canonical', [
        { id: 't-canonical', isCanonical: true },
        { id: 't-dup-1', isCanonical: false },
        { id: 't-dup-2', isCanonical: false },
      ]),
    ]);
    const out = buildRepointPlans(audit);
    expect(out.plans).toHaveLength(2);
    expect(out.plans.map((p) => p.duplicateTenantId).sort()).toEqual(['t-dup-1', 't-dup-2']);
    expect(out.plans.every((p) => p.canonicalTenantId === 't-canonical')).toBe(true);
    expect(out.skipped).toEqual([]);
  });

  it('skips singleton groups (size 1)', () => {
    const audit = makeAudit([
      makeGroup('singleton', 't1', [{ id: 't1', isCanonical: true }]),
    ]);
    expect(buildRepointPlans(audit).plans).toEqual([]);
  });

  it('skips groups with no canonical, but emits skip records for each non-canonical', () => {
    const audit = makeAudit([
      makeGroup('all-zombies', null, [
        { id: 't-z1', isCanonical: false, isZombie: true },
        { id: 't-z2', isCanonical: false, isZombie: true },
      ]),
    ]);
    const out = buildRepointPlans(audit);
    expect(out.plans).toEqual([]);
    expect(out.skipped).toHaveLength(2);
    expect(out.skipped.every((s) => s.reason === 'no_canonical')).toBe(true);
  });

  it('refuses to repoint into a canonical that is an anchor (defensive — audit should never select this)', () => {
    const audit = makeAudit([
      makeGroup('anchor-as-canonical', 't-anchor', [
        { id: 't-anchor', isCanonical: true, isAnchor: true },
        { id: 't-dup', isCanonical: false },
      ]),
    ]);
    const out = buildRepointPlans(audit);
    expect(out.plans).toEqual([]);
    expect(out.skipped).toHaveLength(2);
    expect(out.skipped.every((s) => s.reason === 'canonical_is_anchor')).toBe(true);
  });

  it('refuses to process an anchor as a duplicate even if audit lists it', () => {
    const audit = makeAudit([
      makeGroup('mixed-anchor', 't-canonical', [
        { id: 't-canonical', isCanonical: true },
        { id: 't-anchor-dup', isCanonical: false, isAnchor: true },
        { id: 't-real-dup', isCanonical: false },
      ]),
    ]);
    const out = buildRepointPlans(audit);
    expect(out.plans).toHaveLength(1);
    expect(out.plans[0].duplicateTenantId).toBe('t-real-dup');
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0].reason).toBe('duplicate_is_anchor');
    expect(out.skipped[0].duplicateTenantId).toBe('t-anchor-dup');
  });

  it('respects --tenant-id filter', () => {
    const audit = makeAudit([
      makeGroup('g1', 't-c1', [
        { id: 't-c1', isCanonical: true },
        { id: 't-d1', isCanonical: false },
        { id: 't-d2', isCanonical: false },
      ]),
    ]);
    const out = buildRepointPlans(audit, { tenantIdFilter: 't-d2' });
    expect(out.plans).toHaveLength(1);
    expect(out.plans[0].duplicateTenantId).toBe('t-d2');
  });

  it('emits a skip when --tenant-id is not in any group', () => {
    const audit = makeAudit([
      makeGroup('g1', 't-c1', [
        { id: 't-c1', isCanonical: true },
        { id: 't-d1', isCanonical: false },
      ]),
    ]);
    const out = buildRepointPlans(audit, { tenantIdFilter: 't-not-found' });
    expect(out.plans).toEqual([]);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0].reason).toBe('duplicate_not_in_group');
  });

  it('respects --limit AFTER skip filtering', () => {
    const audit = makeAudit([
      makeGroup('g1', 't-c1', [
        { id: 't-c1', isCanonical: true },
        { id: 't-d1', isCanonical: false },
        { id: 't-d2', isCanonical: false },
        { id: 't-d3', isCanonical: false },
      ]),
    ]);
    expect(buildRepointPlans(audit, { limit: 2 }).plans).toHaveLength(2);
    expect(buildRepointPlans(audit, { limit: 1 }).plans).toHaveLength(1);
  });

  it('does NOT emit a plan for the canonical record itself (silent skip — keep it)', () => {
    const audit = makeAudit([
      makeGroup('g', 't-can', [
        { id: 't-can', isCanonical: true },
        { id: 't-dup', isCanonical: false },
      ]),
    ]);
    const out = buildRepointPlans(audit, { tenantIdFilter: 't-can' });
    expect(out.plans).toEqual([]);
    expect(out.skipped).toEqual([]); // no skip — canonical stays
  });
});

// ---------------------------------------------------------------------------
// validateRepointPair
// ---------------------------------------------------------------------------

const PLAN = {
  duplicateTenantId: 't-dup',
  canonicalTenantId: 't-can',
  groupSignature: 'g',
  duplicateAuditReason: 'r',
};

function tenantState(overrides: Partial<LiveTenantState>): LiveTenantState {
  return {
    id: overrides.id ?? 't',
    status: 'active',
    name: 'Test',
    externalId: 'sa-uuid',
    isAnchor: false,
    ...overrides,
  };
}

describe('validateRepointPair', () => {
  it('ok when both tenants exist and are not anchors', () => {
    const r = validateRepointPair(
      PLAN,
      tenantState({ id: 't-dup' }),
      tenantState({ id: 't-can' }),
    );
    expect(r.ok).toBe(true);
  });

  it('rejects when duplicate is missing', () => {
    const r = validateRepointPair(PLAN, null, tenantState({ id: 't-can' }));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('duplicate_missing');
  });

  it('rejects when canonical is missing', () => {
    const r = validateRepointPair(PLAN, tenantState({ id: 't-dup' }), null);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('canonical_missing');
  });

  it('rejects self-repoint (defensive — same id)', () => {
    const r = validateRepointPair(
      { ...PLAN, canonicalTenantId: 't-dup' },
      tenantState({ id: 't-dup' }),
      tenantState({ id: 't-dup' }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('self_repoint');
  });

  it('rejects when canonical is live-anchor (caught by re-check)', () => {
    const r = validateRepointPair(
      PLAN,
      tenantState({ id: 't-dup' }),
      tenantState({ id: 't-can', isAnchor: true }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('canonical_is_anchor_live');
  });

  it('rejects when duplicate is live-anchor', () => {
    const r = validateRepointPair(
      PLAN,
      tenantState({ id: 't-dup', isAnchor: true }),
      tenantState({ id: 't-can' }),
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('duplicate_is_anchor_live');
  });
});

// ---------------------------------------------------------------------------
// formatRepointResultLine
// ---------------------------------------------------------------------------

describe('formatRepointResultLine', () => {
  function r(overrides: Partial<RepointResult> = {}): RepointResult {
    return {
      duplicateTenantId: 'aaaaaaaa-1111-2222-3333-444444444444',
      canonicalTenantId: 'bbbbbbbb-1111-2222-3333-444444444444',
      status: 'ready',
      phonesMoved: 0,
      endpointRoutesMoved: 0,
      webhookSubscriptionsMoved: 0,
      conversationsChecked: 0,
      conversationsFixed: 0,
      ...overrides,
    };
  }

  it('renders ready line with counts', () => {
    const out = formatRepointResultLine(
      r({
        phonesMoved: 1,
        endpointRoutesMoved: 0,
        webhookSubscriptionsMoved: 2,
        conversationsChecked: 14,
        conversationsFixed: 14,
      }),
    );
    expect(out).toContain('phones=1');
    expect(out).toContain('routes=0');
    expect(out).toContain('subs=2');
    expect(out).toContain('convs=14/14');
    expect(out).toContain('aaaaaaaa');
    expect(out).toContain('bbbbbbbb');
  });

  it('renders skipped line', () => {
    const out = formatRepointResultLine(
      r({ status: 'skipped', skippedReason: 'tenant gone' }),
    );
    expect(out).toContain('SKIPPED');
    expect(out).toContain('tenant gone');
  });

  it('renders error line', () => {
    const out = formatRepointResultLine(r({ status: 'error', error: 'connection lost' }));
    expect(out).toContain('ERROR');
    expect(out).toContain('connection lost');
  });
});
