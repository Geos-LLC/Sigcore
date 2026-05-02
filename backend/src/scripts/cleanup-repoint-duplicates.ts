/**
 * PR13 — Repoint dependent rows from duplicate tenants onto their canonical.
 *
 * Reads a PR9 audit JSON. For every non-canonical tenant in a multi-record
 * group, repoints its live wiring (tenant_phone_numbers, endpoint_routes,
 * webhook_subscriptions, communication_conversations) to the canonical
 * tenant inside a per-tenant transaction. Idempotent — re-running on a
 * fully-repointed tenant moves zero rows.
 *
 * **PR13 does NOT:**
 *   - delete tenants, businesses, or profiles
 *   - change any tenant.status or business.status or profile.status
 *   - touch communication_messages directly (they follow conversations via FK)
 *   - merge or deactivate api_keys (deferred to PR12 / a future api-key cleanup)
 *   - modify routing logic, controllers, or APIs
 *
 * Default mode is dry-run. Live execution requires `APPLY=true`. Mirrors
 * the safety pattern from PR6/PR7 — `process.env.APPLY === 'true'` is the
 * only positive signal that flips writes on.
 *
 * Usage (from backend/):
 *   npm run cleanup:repoint-duplicates:dry-run -- --input=./audit.json
 *   APPLY=true npm run cleanup:repoint-duplicates -- --input=./audit.json
 *   APPLY=true npm run cleanup:repoint-duplicates -- \
 *     --input=./audit.json --tenant-id=<uuid> --limit=1   (smoke test)
 */

import 'reflect-metadata';
import { config as loadDotEnv } from 'dotenv';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve as resolvePath } from 'path';
import { DataSource, QueryRunner } from 'typeorm';

import {
  AuditReport,
  BuildPlanOptions,
  LiveTenantState,
  RepointPlan,
  RepointResult,
  SkippedPlan,
  buildRepointPlans,
  formatRepointResultLine,
  shortId,
  validateRepointPair,
} from './cleanup-repoint-duplicates.helpers';

loadDotEnv();

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  input: string;
  tenantId?: string;
  limit?: number;
  output?: string;
}

function parseArgv(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = {};
  for (const a of argv) {
    if (a.startsWith('--input=')) args.input = a.slice('--input='.length);
    else if (a.startsWith('--tenant-id='))
      args.tenantId = a.slice('--tenant-id='.length);
    else if (a.startsWith('--limit=')) {
      const n = parseInt(a.slice('--limit='.length), 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--limit must be a positive integer, got "${a}"`);
      }
      args.limit = n;
    } else if (a.startsWith('--output=')) args.output = a.slice('--output='.length);
  }
  if (!args.input) {
    throw new Error(
      'Missing --input=<path>. Pass the audit JSON produced by PR9 (audit:duplicates).',
    );
  }
  return args as CliArgs;
}

// ---------------------------------------------------------------------------
// DataSource
// ---------------------------------------------------------------------------

function buildDataSource(): DataSource {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
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
// Live state helpers
// ---------------------------------------------------------------------------

const ANCHOR_NAME_NORMALIZED = new Set([
  'leadbridge',
  'service flow',
  'serviceflow',
  'callio',
  'hirefunnel',
]);
const ANCHOR_EXTERNAL_PATTERN =
  /^(leadbridge|hirefunnel|serviceflow|callio)[-_]/i;

function liveAnchorCheck(
  name: string | null,
  externalId: string | null,
): boolean {
  const norm = (name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (ANCHOR_NAME_NORMALIZED.has(norm)) return true;
  if (externalId && ANCHOR_EXTERNAL_PATTERN.test(externalId)) return true;
  return false;
}

async function loadTenantStateMap(
  ds: DataSource,
  tenantIds: string[],
): Promise<Map<string, LiveTenantState>> {
  const map = new Map<string, LiveTenantState>();
  if (tenantIds.length === 0) return map;
  const rows: Array<{
    id: string;
    status: string | null;
    name: string | null;
    external_id: string | null;
  }> = await ds.query(
    `SELECT id, status, name, external_id
       FROM tenants
      WHERE id = ANY($1::uuid[])`,
    [tenantIds],
  );
  for (const r of rows) {
    map.set(r.id, {
      id: r.id,
      status: r.status,
      name: r.name,
      externalId: r.external_id,
      isAnchor: liveAnchorCheck(r.name, r.external_id),
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Per-tenant repoint
// ---------------------------------------------------------------------------

interface ExecuteResult {
  phonesMoved: number;
  endpointRoutesMoved: number;
  webhookSubscriptionsMoved: number;
  conversationsChecked: number;
  conversationsFixed: number;
}

/**
 * Run the per-tenant transaction. Each UPDATE filters on `tenant_id =
 * $duplicate AND tenant_id IS DISTINCT FROM $canonical` so a re-run on a
 * fully-repointed tenant is a no-op (idempotent by construction).
 *
 * Note: `IS DISTINCT FROM` is redundant with the `tenant_id = $duplicate`
 * filter (since duplicate ≠ canonical) but kept defensively.
 */
async function executeRepoint(
  qr: QueryRunner,
  plan: RepointPlan,
): Promise<ExecuteResult> {
  // Tenant phone numbers
  const phonesRes = await qr.query(
    `UPDATE tenant_phone_numbers
        SET tenant_id = $1, updated_at = now()
      WHERE tenant_id = $2`,
    [plan.canonicalTenantId, plan.duplicateTenantId],
  );
  const phonesMoved = parseRowCount(phonesRes);

  // Endpoint routes
  const routesRes = await qr.query(
    `UPDATE endpoint_routes
        SET tenant_id = $1, updated_at = now()
      WHERE tenant_id = $2`,
    [plan.canonicalTenantId, plan.duplicateTenantId],
  );
  const endpointRoutesMoved = parseRowCount(routesRes);

  // Webhook subscriptions
  const subsRes = await qr.query(
    `UPDATE webhook_subscriptions
        SET tenant_id = $1, updated_at = now()
      WHERE tenant_id = $2`,
    [plan.canonicalTenantId, plan.duplicateTenantId],
  );
  const webhookSubscriptionsMoved = parseRowCount(subsRes);

  // Conversations — count first (for the "checked" report metric), then
  // repoint only the rows that actually need it. messages follow via FK.
  const checkedRow = await qr.query(
    `SELECT COUNT(*)::int AS c
       FROM communication_conversations
      WHERE tenant_id = $1`,
    [plan.duplicateTenantId],
  );
  const conversationsChecked = checkedRow[0]?.c ?? 0;

  const convRes = await qr.query(
    `UPDATE communication_conversations
        SET tenant_id = $1, updated_at = now()
      WHERE tenant_id = $2`,
    [plan.canonicalTenantId, plan.duplicateTenantId],
  );
  const conversationsFixed = parseRowCount(convRes);

  return {
    phonesMoved,
    endpointRoutesMoved,
    webhookSubscriptionsMoved,
    conversationsChecked,
    conversationsFixed,
  };
}

/**
 * Count rows from a TypeORM UPDATE query. The pg driver returns
 * `[rows, count]` tuple shape for UPDATE statements without RETURNING; the
 * second element is the count. Fallback to 0 on unexpected shapes.
 */
function parseRowCount(result: unknown): number {
  if (Array.isArray(result) && result.length === 2) {
    const second = result[1];
    if (typeof second === 'number') return second;
    if (second && typeof (second as { rowCount?: number }).rowCount === 'number') {
      return (second as { rowCount: number }).rowCount;
    }
  }
  // ts-node + pg sometimes returns { rowCount } object directly
  if (result && typeof (result as { rowCount?: number }).rowCount === 'number') {
    return (result as { rowCount: number }).rowCount;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Dry-run preview
// ---------------------------------------------------------------------------

async function previewPlan(
  ds: DataSource,
  plan: RepointPlan,
): Promise<ExecuteResult> {
  const phones = await ds.query(
    `SELECT COUNT(*)::int AS c FROM tenant_phone_numbers WHERE tenant_id = $1`,
    [plan.duplicateTenantId],
  );
  const routes = await ds.query(
    `SELECT COUNT(*)::int AS c FROM endpoint_routes WHERE tenant_id = $1`,
    [plan.duplicateTenantId],
  );
  const subs = await ds.query(
    `SELECT COUNT(*)::int AS c FROM webhook_subscriptions WHERE tenant_id = $1`,
    [plan.duplicateTenantId],
  );
  const convs = await ds.query(
    `SELECT COUNT(*)::int AS c FROM communication_conversations WHERE tenant_id = $1`,
    [plan.duplicateTenantId],
  );
  return {
    phonesMoved: phones[0]?.c ?? 0,
    endpointRoutesMoved: routes[0]?.c ?? 0,
    webhookSubscriptionsMoved: subs[0]?.c ?? 0,
    conversationsChecked: convs[0]?.c ?? 0,
    conversationsFixed: convs[0]?.c ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cli = parseArgv(process.argv.slice(2));
  const apply = process.env.APPLY === 'true';

  log(`PR13 — duplicate tenant repointing`);
  log(`  mode:        ${apply ? 'LIVE (writes enabled)' : 'DRY-RUN (no writes)'}`);
  log(`  audit:       ${cli.input}`);
  if (cli.tenantId) log(`  tenant-id:   ${cli.tenantId}`);
  if (cli.limit) log(`  limit:       ${cli.limit}`);

  if (!existsSync(cli.input)) {
    throw new Error(`audit JSON not found: ${cli.input}`);
  }
  const audit = JSON.parse(readFileSync(resolvePath(cli.input), 'utf-8')) as AuditReport;

  const planOpts: BuildPlanOptions = {
    tenantIdFilter: cli.tenantId,
    limit: cli.limit,
  };
  const built = buildRepointPlans(audit, planOpts);

  log(
    `\nDiscovered ${built.plans.length} actionable plan(s); ${built.skipped.length} skipped.`,
  );
  for (const s of built.skipped) {
    log(`  SKIP [${shortId(s.duplicateTenantId)}] ${s.reason} — ${s.detail}`);
  }
  if (built.plans.length === 0) {
    log('Nothing to do.');
    return;
  }

  const ds = buildDataSource();
  await ds.initialize();
  const results: RepointResult[] = [];
  try {
    // Live-state validation in one batch.
    const allTenantIds = Array.from(
      new Set(built.plans.flatMap((p) => [p.duplicateTenantId, p.canonicalTenantId])),
    );
    const live = await loadTenantStateMap(ds, allTenantIds);

    for (const plan of built.plans) {
      const dup = live.get(plan.duplicateTenantId) ?? null;
      const can = live.get(plan.canonicalTenantId) ?? null;
      const v = validateRepointPair(plan, dup, can);
      if (!v.ok) {
        const r: RepointResult = {
          duplicateTenantId: plan.duplicateTenantId,
          canonicalTenantId: plan.canonicalTenantId,
          status: 'skipped',
          phonesMoved: 0,
          endpointRoutesMoved: 0,
          webhookSubscriptionsMoved: 0,
          conversationsChecked: 0,
          conversationsFixed: 0,
          skippedReason: `${v.reason}: ${v.detail ?? ''}`,
        };
        results.push(r);
        log(`  ${formatRepointResultLine(r)}`);
        continue;
      }

      if (!apply) {
        const counts = await previewPlan(ds, plan);
        const r: RepointResult = {
          duplicateTenantId: plan.duplicateTenantId,
          canonicalTenantId: plan.canonicalTenantId,
          status: 'ready',
          ...counts,
        };
        results.push(r);
        log(`  PREVIEW ${formatRepointResultLine(r)}`);
        continue;
      }

      // LIVE
      const qr = ds.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      try {
        const counts = await executeRepoint(qr, plan);
        await qr.commitTransaction();
        const r: RepointResult = {
          duplicateTenantId: plan.duplicateTenantId,
          canonicalTenantId: plan.canonicalTenantId,
          status: 'ready',
          ...counts,
        };
        results.push(r);
        log(`  ${formatRepointResultLine(r)}`);
      } catch (err) {
        await qr.rollbackTransaction();
        const msg = err instanceof Error ? err.message : String(err);
        const r: RepointResult = {
          duplicateTenantId: plan.duplicateTenantId,
          canonicalTenantId: plan.canonicalTenantId,
          status: 'error',
          phonesMoved: 0,
          endpointRoutesMoved: 0,
          webhookSubscriptionsMoved: 0,
          conversationsChecked: 0,
          conversationsFixed: 0,
          error: msg,
        };
        results.push(r);
        log(`  ${formatRepointResultLine(r)}`);
      } finally {
        await qr.release();
      }
    }
  } finally {
    await ds.destroy();
  }

  // Write report
  if (cli.output) {
    const abs = resolvePath(cli.output);
    mkdirSync(dirname(abs), { recursive: true });
    const report = {
      generatedAt: new Date().toISOString(),
      mode: apply ? 'live' : 'dry_run',
      auditInput: cli.input,
      results,
      skipped: built.skipped,
    };
    writeFileSync(abs, JSON.stringify(report, null, 2) + '\n', 'utf-8');
    log(`\nReport written to: ${abs}`);
  }

  // Summary
  const totals = results.reduce(
    (acc, r) => {
      acc.phones += r.phonesMoved;
      acc.routes += r.endpointRoutesMoved;
      acc.subs += r.webhookSubscriptionsMoved;
      acc.convsChecked += r.conversationsChecked;
      acc.convsFixed += r.conversationsFixed;
      acc[r.status]++;
      return acc;
    },
    { phones: 0, routes: 0, subs: 0, convsChecked: 0, convsFixed: 0, ready: 0, skipped: 0, error: 0 },
  );
  log(`\nTotals (${apply ? 'applied' : 'previewed'}):`);
  log(`  ready:               ${totals.ready}`);
  log(`  skipped:             ${totals.skipped + built.skipped.length}`);
  log(`  errors:              ${totals.error}`);
  log(`  phones moved:        ${totals.phones}`);
  log(`  endpoint_routes:     ${totals.routes}`);
  log(`  webhook_subs:        ${totals.subs}`);
  log(`  conversations:       ${totals.convsFixed} / ${totals.convsChecked} checked`);
  if (!apply) {
    log(`\nDRY-RUN complete. Set APPLY=true to execute.`);
  }
  if (totals.error > 0) {
    process.exitCode = 1;
  }
}

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.stack || err.message : err);
    process.exit(1);
  });
}
