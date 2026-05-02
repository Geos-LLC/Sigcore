/**
 * PR7 — backfill conversation → profile_id for LeadBridge tenants.
 *
 * After PR6 materialized real Thumbtack/Yelp profiles and demoted the
 * synthetic "Default" profile, existing conversations still carry the OLD
 * default profile id. This script repoints them to the new (active)
 * profile by resolving each conversation's phone through the same
 * (tenant_phone_numbers → profile_phone_assignments) chain the live
 * inbound resolver uses.
 *
 * Scope:
 *   - Only LB tenants — defined as: a kept demoted default profile exists
 *     under the tenant's business with slug='default' and source='leadbridge'.
 *   - Only conversations where communication_profile_id = oldDefaultProfileId.
 *   - Sets profile_confidence='backfill' so the source of the change is
 *     attributable in audit / metrics queries.
 *
 * Constraints (locked):
 *   - Per-tenant transaction (one bad tenant doesn't poison the run).
 *   - Idempotent (the WHERE filter on OLD profile id excludes already-migrated rows).
 *   - No routing changes, no deletes, no schema changes.
 *
 * Usage:
 *   DRY_RUN=1 npm run lb:backfill-conversations:dry-run
 *   DRY_RUN=0 npm run lb:backfill-conversations
 *
 *   --tenant-id=<uuid>    optional: limit run to one tenant (smoke test)
 *   --limit=<N>           optional: cap conversations moved per tenant
 *                                   (omitted = no cap)
 *
 * Default mode is dry-run; live writes require DRY_RUN=0.
 */

import 'reflect-metadata';
import { config as loadDotEnv } from 'dotenv';
import { DataSource, QueryRunner } from 'typeorm';

import {
  BackfillTenantResult,
  BackfillTenantTarget,
  buildAlreadyMigratedCountSql,
  buildBackfillSql,
  buildRunSummary,
  buildUnresolvedCountSql,
  extractReturningRows,
  formatTenantResult,
} from './lb-backfill-conversation-profiles.helpers';

loadDotEnv();

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  tenantId?: string;
  limit?: number;
}

function parseArgv(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (const a of argv) {
    if (a.startsWith('--tenant-id=')) {
      args.tenantId = a.slice('--tenant-id='.length);
    } else if (a.startsWith('--limit=')) {
      const n = parseInt(a.slice('--limit='.length), 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--limit must be a positive integer, got "${a}"`);
      }
      args.limit = n;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// DataSource
// ---------------------------------------------------------------------------

function buildDataSource(): DataSource {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL not set — script cannot connect.');
  }
  const isProduction = process.env.NODE_ENV === 'production';
  return new DataSource({
    type: 'postgres',
    url,
    entities: [],
    migrations: [],
    synchronize: false,
    ssl: isProduction ? { rejectUnauthorized: false } : false,
    logging: false,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cliArgs = parseArgv(process.argv.slice(2));
  const dryRun = process.env.DRY_RUN !== '0';

  log(`Mode: ${dryRun ? 'DRY-RUN (no writes)' : 'LIVE (writes enabled)'}`);
  if (cliArgs.tenantId) log(`Limited to tenant: ${cliArgs.tenantId}`);
  if (cliArgs.limit) log(`Per-tenant cap: ${cliArgs.limit} conversations`);

  const ds = buildDataSource();
  await ds.initialize();
  try {
    await runWithDataSource(ds, cliArgs, dryRun);
  } finally {
    await ds.destroy();
  }
}

async function runWithDataSource(
  ds: DataSource,
  args: CliArgs,
  dryRun: boolean,
): Promise<void> {
  // ---------- 1. Discover targets ----------
  const targets = await loadTargets(ds, args.tenantId);
  log(
    `Discovered ${targets.length} LB tenant(s) with a demoted Default profile ` +
      `(slug='default', source='leadbridge', is_default=FALSE).`,
  );

  if (targets.length === 0) {
    log('Nothing to do. Did PR6 (lb-materialize-profiles) run?');
    return;
  }

  // ---------- 2. Pre-flight: per-tenant moveable counts ----------
  const previews = await Promise.all(
    targets.map((t) => previewTenant(ds, t, args.limit)),
  );
  printPreview(targets, previews);

  if (dryRun) {
    log('\nDRY_RUN=1 — no writes performed. Set DRY_RUN=0 to execute.');
    return;
  }

  // ---------- 3. Execute (per-tenant transaction) ----------
  const perTenant: Array<{ result: BackfillTenantResult; failure?: string }> = [];

  for (const target of targets) {
    const qr = ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const result = await executeTenant(qr, target, args.limit);
      await qr.commitTransaction();
      perTenant.push({ result });
      log(`  ${formatTenantResult(result, target.tenantName)}`);
    } catch (err) {
      await qr.rollbackTransaction();
      const msg = err instanceof Error ? err.message : String(err);
      perTenant.push({
        result: {
          tenantId: target.tenantId,
          moved: 0,
          unresolved: 0,
          alreadyMigrated: 0,
        },
        failure: msg,
      });
      log(`  [tenant ${target.tenantId}] FAILED: ${msg}`);
    } finally {
      await qr.release();
    }
  }

  // ---------- 4. Summary ----------
  const summary = buildRunSummary(perTenant, 0);
  log(
    `\nLive run complete: ` +
      `processed=${summary.tenantsProcessed} ` +
      `moved=${summary.totalMoved} ` +
      `unresolved=${summary.totalUnresolved} ` +
      `already=${summary.totalAlreadyMigrated} ` +
      `failed=${summary.failures.length}`,
  );

  if (summary.failures.length > 0) {
    log('\nFailures:');
    for (const f of summary.failures) {
      log(`  [tenant ${f.tenantId}] ${f.error}`);
    }
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// DB reads
// ---------------------------------------------------------------------------

async function loadTargets(
  ds: DataSource,
  tenantIdFilter: string | undefined,
): Promise<BackfillTenantTarget[]> {
  // Find every tenant where there's a demoted default profile (slug='default',
  // is_default=FALSE) with source='leadbridge'. That's the marker PR6 leaves
  // behind: the kept-for-back-compat row. If there's no such row, either
  // PR6 hasn't run yet or the tenant was already cleaned — skip.
  const params: unknown[] = [];
  let where = '';
  if (tenantIdFilter) {
    params.push(tenantIdFilter);
    where = 'AND t.id = $1';
  }

  const rows: Array<{
    tenant_id: string;
    workspace_id: string;
    tenant_name: string | null;
    old_default_profile_id: string;
  }> = await ds.query(
    `
    SELECT
      t.id          AS tenant_id,
      t.workspace_id AS workspace_id,
      t.name        AS tenant_name,
      cp.id         AS old_default_profile_id
    FROM tenants t
    JOIN communication_businesses cb
      ON cb.tenant_id = t.id
    JOIN communication_profiles cp
      ON cp.communication_business_id = cb.id
     AND cp.slug = 'default'
     AND cp.source = 'leadbridge'
     AND cp.is_default = FALSE
    ${where}
    `,
    params,
  );

  return rows.map((r) => ({
    tenantId: r.tenant_id,
    workspaceId: r.workspace_id,
    tenantName: r.tenant_name,
    oldDefaultProfileId: r.old_default_profile_id,
  }));
}

interface TenantPreview {
  toMove: number;
  unresolvedNow: number;
  alreadyMigrated: number;
}

async function previewTenant(
  ds: DataSource,
  target: BackfillTenantTarget,
  limit: number | undefined,
): Promise<TenantPreview> {
  // How many conversations would the UPDATE touch right now?
  const moveableSql = `
    SELECT COUNT(*)::int AS count
      FROM (
        SELECT DISTINCT ON (c.id) c.id
          FROM communication_conversations c
          JOIN tenant_phone_numbers tpn
            ON tpn.tenant_id = c.tenant_id
           AND tpn.phone_number = c.phone_number
          JOIN profile_phone_assignments ppa
            ON ppa.tenant_phone_number_id = tpn.id
           AND ppa.active = TRUE
         WHERE c.tenant_id = $1
           AND c.communication_profile_id = $2
         ORDER BY c.id, ppa.is_default DESC, ppa.priority DESC
         ${limit ? `LIMIT ${limit}` : ''}
      ) sub
  `;
  const [moveable]: Array<{ count: number }> = await ds.query(moveableSql, [
    target.tenantId,
    target.oldDefaultProfileId,
  ]);

  // How many on-old-default conversations exist in total? (moveable + unresolvable)
  const [totalOnOld]: Array<{ count: number }> = await ds.query(
    buildUnresolvedCountSql(),
    [target.tenantId, target.oldDefaultProfileId],
  );

  const [alreadyMigrated]: Array<{ count: number }> = await ds.query(
    buildAlreadyMigratedCountSql(),
    [target.tenantId],
  );

  return {
    toMove: moveable.count,
    unresolvedNow: Math.max(0, totalOnOld.count - moveable.count),
    alreadyMigrated: alreadyMigrated.count,
  };
}

function printPreview(
  targets: BackfillTenantTarget[],
  previews: TenantPreview[],
): void {
  log(`\nPer-tenant preview:`);
  let totalToMove = 0;
  let totalUnresolved = 0;
  let totalAlready = 0;
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const p = previews[i];
    totalToMove += p.toMove;
    totalUnresolved += p.unresolvedNow;
    totalAlready += p.alreadyMigrated;
    const label = t.tenantName ? `"${t.tenantName}"` : '<no name>';
    log(
      `  [tenant ${shortId(t.tenantId)} ${label}] ` +
        `to_move=${p.toMove} unresolvable=${p.unresolvedNow} already=${p.alreadyMigrated}`,
    );
  }
  log(
    `\nTotals: to_move=${totalToMove} unresolvable=${totalUnresolved} already=${totalAlready}`,
  );
  if (totalUnresolved > 0) {
    log(
      `Note: ${totalUnresolved} conversation(s) have no active PPA for their phone — ` +
        `they will be left on the old default profile and reported as "unresolved".`,
    );
  }
}

// ---------------------------------------------------------------------------
// DB writes (per-tenant transaction)
// ---------------------------------------------------------------------------

async function executeTenant(
  qr: QueryRunner,
  target: BackfillTenantTarget,
  limit: number | undefined,
): Promise<BackfillTenantResult> {
  // The CTE-based UPDATE is the heart of the script. If `--limit` is set,
  // we wrap with a subquery that LIMITs the conversation set first to keep
  // smoke runs bounded; otherwise we use the canonical SQL from helpers
  // verbatim.
  let updateSql = buildBackfillSql();
  if (limit) {
    // Inject a LIMIT into the inner DISTINCT ON select. The helper SQL is
    // intentionally simple so this textual splice stays safe; we only
    // append `LIMIT N` inside the CTE's ORDER BY tail.
    updateSql = updateSql.replace(
      /ORDER BY c\.id, ppa\.is_default DESC, ppa\.priority DESC\s*\)/,
      `ORDER BY c.id, ppa.is_default DESC, ppa.priority DESC\n         LIMIT ${limit}\n    )`,
    );
  }

  const rawResult = await qr.query(updateSql, [
    target.tenantId,
    target.oldDefaultProfileId,
  ]);
  const movedRows = extractReturningRows<{ id: string }>(rawResult);
  const moved = movedRows.length;

  const [unresolvedRow]: Array<{ count: number }> = await qr.query(
    buildUnresolvedCountSql(),
    [target.tenantId, target.oldDefaultProfileId],
  );

  const [alreadyMigratedRow]: Array<{ count: number }> = await qr.query(
    buildAlreadyMigratedCountSql(),
    [target.tenantId],
  );

  return {
    tenantId: target.tenantId,
    moved,
    unresolved: unresolvedRow.count,
    alreadyMigrated: alreadyMigratedRow.count,
  };
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.stack || err.message : err);
    process.exit(1);
  });
}
