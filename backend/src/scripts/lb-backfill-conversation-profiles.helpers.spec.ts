import {
  BackfillTenantResult,
  buildAlreadyMigratedCountSql,
  buildBackfillSql,
  buildRunSummary,
  buildUnresolvedCountSql,
  extractReturningRows,
  formatTenantResult,
} from './lb-backfill-conversation-profiles.helpers';

describe('buildBackfillSql', () => {
  it('uses parameterised tenant_id and old default profile id', () => {
    const sql = buildBackfillSql();
    expect(sql).toMatch(/c\.tenant_id\s*=\s*\$1/);
    expect(sql).toMatch(/c\.communication_profile_id\s*=\s*\$2/);
  });

  it('only joins ACTIVE profile_phone_assignments', () => {
    const sql = buildBackfillSql();
    expect(sql).toMatch(/ppa\.active\s*=\s*TRUE/);
  });

  it('orders ppa picks by (is_default DESC, priority DESC) for determinism', () => {
    const sql = buildBackfillSql();
    expect(sql).toMatch(/ppa\.is_default DESC,\s*ppa\.priority DESC/);
  });

  it('uses DISTINCT ON conversation id so each conversation gets exactly one new profile', () => {
    const sql = buildBackfillSql();
    expect(sql).toMatch(/DISTINCT ON \(c\.id\)/);
  });

  it("writes profile_confidence='backfill' and returns conversation ids", () => {
    const sql = buildBackfillSql();
    expect(sql).toMatch(/profile_confidence\s*=\s*'backfill'/);
    expect(sql).toMatch(/RETURNING c\.id/);
  });

  it("guards the UPDATE WHERE on the OLD profile id so re-runs can't overwrite already-migrated rows", () => {
    const sql = buildBackfillSql();
    // The outer UPDATE … WHERE clause must filter on $2 (old default profile id)
    // — that's what makes the script idempotent on re-run.
    const updateBlock = sql.split('UPDATE communication_conversations')[1] ?? '';
    expect(updateBlock).toMatch(/c\.communication_profile_id\s*=\s*\$2/);
  });

  it('coalesces communication_business_id (does not stomp existing values)', () => {
    const sql = buildBackfillSql();
    expect(sql).toMatch(/communication_business_id\s*=\s*COALESCE\(c\.communication_business_id,\s*ctp\.new_business_id\)/);
  });
});

describe('buildUnresolvedCountSql', () => {
  it('counts conversations still on the old default after the update', () => {
    const sql = buildUnresolvedCountSql();
    expect(sql).toMatch(/c\.tenant_id\s*=\s*\$1/);
    expect(sql).toMatch(/c\.communication_profile_id\s*=\s*\$2/);
  });
});

describe('buildAlreadyMigratedCountSql', () => {
  it("counts only conversations marked profile_confidence='backfill'", () => {
    const sql = buildAlreadyMigratedCountSql();
    expect(sql).toMatch(/profile_confidence\s*=\s*'backfill'/);
    expect(sql).toMatch(/c\.tenant_id\s*=\s*\$1/);
  });
});

describe('formatTenantResult', () => {
  it('prints a single line with moved/unresolved/already counts', () => {
    const r: BackfillTenantResult = {
      tenantId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      moved: 7,
      unresolved: 1,
      alreadyMigrated: 3,
    };
    const out = formatTenantResult(r, 'Spotless Homes Tampa');
    expect(out).toContain('moved=7');
    expect(out).toContain('unresolved=1');
    expect(out).toContain('already=3');
    expect(out).toContain('"Spotless Homes Tampa"');
    // Short tenant id (first 8 chars) for readability.
    expect(out).toContain('aaaaaaaa');
  });

  it('handles missing tenant name', () => {
    const out = formatTenantResult(
      { tenantId: 't1', moved: 0, unresolved: 0, alreadyMigrated: 0 },
      null,
    );
    expect(out).toContain('<no name>');
  });
});

describe('extractReturningRows', () => {
  it('returns the rows array when TypeORM gives the [rows, info] tuple shape', () => {
    // Real shape observed from CTE+UPDATE...RETURNING under TypeORM 0.3 / pg
    const tupleShape: unknown = [
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      { rowCount: 3 },
    ];
    expect(extractReturningRows<{ id: string }>(tupleShape)).toEqual([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ]);
  });

  it('returns the input when TypeORM gives the rows-array shape directly (INSERT...RETURNING path)', () => {
    const rowsShape: unknown = [{ id: 'x' }, { id: 'y' }];
    expect(extractReturningRows<{ id: string }>(rowsShape)).toEqual([
      { id: 'x' },
      { id: 'y' },
    ]);
  });

  it('returns [] for empty rows array', () => {
    expect(extractReturningRows<{ id: string }>([])).toEqual([]);
  });

  it('returns [] for empty tuple-shape rows', () => {
    expect(extractReturningRows<{ id: string }>([[], { rowCount: 0 }])).toEqual([]);
  });

  it('does NOT misclassify a 2-row plain array as a tuple', () => {
    // Two ROW objects (not an array + info) — must stay as-is, not unwrap to row[0].
    const twoRows: unknown = [{ id: 'one' }, { id: 'two' }];
    expect(extractReturningRows<{ id: string }>(twoRows)).toEqual([
      { id: 'one' },
      { id: 'two' },
    ]);
  });

  it('returns [] for a non-array result', () => {
    expect(extractReturningRows({})).toEqual([]);
    expect(extractReturningRows(null)).toEqual([]);
    expect(extractReturningRows(undefined)).toEqual([]);
  });
});

describe('buildRunSummary', () => {
  it('aggregates per-tenant counts and surfaces failures separately', () => {
    const out = buildRunSummary(
      [
        {
          result: { tenantId: 't1', moved: 4, unresolved: 0, alreadyMigrated: 1 },
        },
        {
          result: { tenantId: 't2', moved: 2, unresolved: 1, alreadyMigrated: 0 },
        },
        {
          result: { tenantId: 't3', moved: 0, unresolved: 0, alreadyMigrated: 0 },
          failure: 'connection timeout',
        },
      ],
      2,
    );
    expect(out.tenantsProcessed).toBe(2);
    expect(out.tenantsSkipped).toBe(2);
    expect(out.totalMoved).toBe(6);
    expect(out.totalUnresolved).toBe(1);
    expect(out.totalAlreadyMigrated).toBe(1);
    expect(out.failures).toEqual([{ tenantId: 't3', error: 'connection timeout' }]);
  });

  it('handles empty input', () => {
    const out = buildRunSummary([], 0);
    expect(out).toEqual({
      tenantsProcessed: 0,
      tenantsSkipped: 0,
      totalMoved: 0,
      totalUnresolved: 0,
      totalAlreadyMigrated: 0,
      failures: [],
    });
  });
});
