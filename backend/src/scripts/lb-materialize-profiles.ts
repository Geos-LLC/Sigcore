/**
 * Materialize real LeadBridge Thumbtack/Yelp profiles in Sigcore (Option B).
 *
 * For every Sigcore tenant whose default profile.source = 'leadbridge', this
 * script replaces the synthetic "Default" profile with a real source-bound
 * profile (Thumbtack or Yelp) tied to a LeadBridge SavedAccount.
 *
 * Scope (locked):
 *   - tenants are NOT modified
 *   - routing logic is NOT modified
 *   - public APIs are NOT modified
 *   - only ACTIVE profile_phone_assignments are repointed
 *   - the existing "Default" profile is demoted (is_default=FALSE) but kept
 *     for backward compatibility
 *
 * Usage:
 *   DRY_RUN=1 npm run lb:materialize -- --input=./lb-saved-accounts.json
 *   DRY_RUN=0 npm run lb:materialize -- --input=./lb-saved-accounts.json \
 *                                       --location-map=./lb-locations.json
 *
 *   --input        path to JSON array of LbSavedAccount records (required)
 *   --location-map path to JSON object: { savedAccountId: {locationKey, locationDisplay} }
 *   --tenant-id    optional: limit run to one tenant id (smoke testing)
 *
 * The script is idempotent — re-running is a no-op once every tenant is
 * materialized, because the second pass detects the existing source profile
 * (matched on partial-unique index) and emits no new writes.
 */

import 'reflect-metadata';
import { config as loadDotEnv } from 'dotenv';
import { readFileSync } from 'fs';
import { resolve as resolvePath } from 'path';
import { DataSource, QueryRunner } from 'typeorm';

import {
  LbSavedAccount,
  LocationMap,
  TenantInput,
  TenantPlan,
  evaluateValidationGate,
  planForTenant,
  validateTenantSavedAccountAlignment,
} from './lb-materialize-profiles.helpers';

loadDotEnv();

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  input: string;
  locationMap?: string;
  tenantId?: string;
  /**
   * When true, validation issues of type 'no_saved_account_for_external_id'
   * (a Sigcore tenant whose external_id has no matching LB SavedAccount —
   * a "zombie" / orphan tenant) are demoted from hard validation failures
   * to soft skips, and the live run is allowed to proceed.
   *
   * Other validation issue types (e.g. unsupported_platform_in_saved_account)
   * still abort. Use this flag only after independently confirming the
   * orphans are dead (no LB row, no recent traffic).
   */
  allowOrphanTenants: boolean;
}

function parseArgv(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = { allowOrphanTenants: false };
  for (const a of argv) {
    if (a.startsWith('--input=')) args.input = a.slice('--input='.length);
    else if (a.startsWith('--location-map='))
      args.locationMap = a.slice('--location-map='.length);
    else if (a.startsWith('--tenant-id='))
      args.tenantId = a.slice('--tenant-id='.length);
    else if (a === '--allow-orphan-tenants') args.allowOrphanTenants = true;
  }
  if (!args.input) {
    throw new Error(
      'Missing --input=<path>. Pass a JSON file with the LB SavedAccount export.',
    );
  }
  return args as CliArgs;
}

function readJson<T>(path: string): T {
  const abs = resolvePath(path);
  const raw = readFileSync(abs, 'utf-8');
  return JSON.parse(raw) as T;
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

interface RunOptions {
  dryRun: boolean;
  args: CliArgs;
}

async function main(): Promise<void> {
  const cliArgs = parseArgv(process.argv.slice(2));
  const dryRun = process.env.DRY_RUN !== '0';

  const savedAccounts = readJson<LbSavedAccount[]>(cliArgs.input);
  if (!Array.isArray(savedAccounts)) {
    throw new Error(`--input must be a JSON array; got ${typeof savedAccounts}`);
  }
  const savedById = new Map<string, LbSavedAccount>();
  for (const sa of savedAccounts) savedById.set(sa.id, sa);

  const locationMap: LocationMap | undefined = cliArgs.locationMap
    ? readJson<LocationMap>(cliArgs.locationMap)
    : undefined;

  log(`Mode: ${dryRun ? 'DRY-RUN (no writes)' : 'LIVE (writes enabled)'}`);
  log(`Input: ${cliArgs.input} (${savedAccounts.length} saved accounts loaded)`);
  if (cliArgs.locationMap) log(`Location map: ${cliArgs.locationMap}`);
  if (cliArgs.tenantId) log(`Limited to tenant: ${cliArgs.tenantId}`);

  const ds = buildDataSource();
  await ds.initialize();
  try {
    await runWithDataSource(ds, savedById, locationMap, { dryRun, args: cliArgs });
  } finally {
    await ds.destroy();
  }
}

async function runWithDataSource(
  ds: DataSource,
  savedById: Map<string, LbSavedAccount>,
  locationMap: LocationMap | undefined,
  opts: RunOptions,
): Promise<void> {
  // ---------- 1. Load LB tenants (defined as: default profile source='leadbridge') ----------
  const inputs = await loadTenantInputs(ds, savedById, opts.args.tenantId);
  log(`Discovered ${inputs.length} LB tenant(s) with default profile source='leadbridge'`);

  // ---------- 2. Validate tenant ↔ SavedAccount alignment ----------
  const tenantsForValidation = inputs.map((t) => ({
    tenantId: t.tenantId,
    tenantExternalId: t.tenantExternalId,
  }));
  const validation = validateTenantSavedAccountAlignment(tenantsForValidation, savedById);
  const gate = evaluateValidationGate({
    validation,
    dryRun: opts.dryRun,
    allowOrphanTenants: opts.args.allowOrphanTenants,
  });

  if (!validation.ok) {
    if (gate.reason === 'orphans_allowed') {
      log(
        `\nVALIDATION: ${gate.orphans.length} orphan tenant(s) detected — ` +
          `--allow-orphan-tenants set, demoting to soft skips:`,
      );
      for (const issue of gate.orphans) {
        log(`  [tenant ${issue.tenantId}] ${issue.reason}: ${issue.detail}`);
      }
    } else {
      log(`\nVALIDATION FAILED — ${validation.issues.length} issue(s):`);
      for (const issue of validation.issues) {
        log(`  [tenant ${issue.tenantId}] ${issue.reason}: ${issue.detail}`);
      }
      log(
        '\nFix the input file (or the prod DB) so that every leadbridge tenant.external_id ' +
          'maps to exactly one LB SavedAccount, then re-run.',
      );
      if (gate.reason === 'hard_issues_present' && opts.args.allowOrphanTenants) {
        log(
          `\n--allow-orphan-tenants is set, but ${gate.hardIssues.length} non-orphan ` +
            `issue(s) remain — those still abort.`,
        );
      } else if (gate.reason === 'orphans_not_allowed') {
        log(
          '\nIf you have independently verified that the unmatched tenants are ' +
            "dead (no LB row, no recent traffic), pass --allow-orphan-tenants to proceed.",
        );
      }
      if (gate.decision === 'abort') {
        throw new Error('Validation failed — refusing to write.');
      }
      log('(dry-run continues so you can preview the plans for valid tenants)');
    }
  }

  // ---------- 3. Build per-tenant plans ----------
  const plans: TenantPlan[] = [];
  for (const t of inputs) {
    const sa = savedById.get(t.tenantExternalId ?? '');
    if (!sa) {
      // Already reported by validation; emit a structured skip too.
      plans.push({
        kind: 'skip',
        tenantId: t.tenantId,
        reason: 'tenant_external_id_mismatch',
        detail: 'no SavedAccount for external_id',
      });
      continue;
    }
    const merged: TenantInput = { ...t, savedAccount: sa };
    plans.push(planForTenant(merged, locationMap ?? null));
  }

  // ---------- 4. Print plan summary ----------
  printPlanSummary(plans);

  if (opts.dryRun) {
    log('\nDRY_RUN=1 — no writes performed. Set DRY_RUN=0 to execute.');
    return;
  }

  // Defensive — the gate above already aborts when needed. Re-evaluate
  // here as a tripwire: should never throw if the gate logic above ran,
  // but keeps the executor honest if someone refactors the upstream check.
  if (gate.decision === 'abort') {
    throw new Error('Refusing to execute: validation failed.');
  }

  // ---------- 5. Execute (per-tenant transaction) ----------
  let applied = 0;
  let noop = 0;
  let skipped = 0;
  const failures: Array<{ tenantId: string; error: string }> = [];

  for (const plan of plans) {
    if (plan.kind === 'skip') {
      skipped++;
      continue;
    }
    const qr = ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const result = await executePlan(qr, plan);
      await qr.commitTransaction();
      if (result === 'noop') noop++;
      else applied++;
    } catch (err) {
      await qr.rollbackTransaction();
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({ tenantId: plan.tenantId, error: msg });
      log(`  [tenant ${plan.tenantId}] FAILED: ${msg}`);
    } finally {
      await qr.release();
    }
  }

  log(
    `\nLive run complete: ${applied} applied, ${noop} no-op (already materialized), ` +
      `${skipped} skipped, ${failures.length} failed.`,
  );
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// DB reads
// ---------------------------------------------------------------------------

async function loadTenantInputs(
  ds: DataSource,
  savedById: Map<string, LbSavedAccount>,
  tenantIdFilter: string | undefined,
): Promise<Omit<TenantInput, 'savedAccount'>[]> {
  // Single round-trip: tenants joined to their (single) communication_business
  // and (single) is_default=TRUE communication_profile, plus the count of
  // active phone assignments.
  const params: unknown[] = [];
  let where = '';
  if (tenantIdFilter) {
    params.push(tenantIdFilter);
    where = 'AND t.id = $1';
  }

  const rows: Array<{
    tenant_id: string;
    workspace_id: string;
    tenant_external_id: string | null;
    tenant_name: string | null;
    business_id: string;
    business_display_name: string;
    business_metadata: Record<string, unknown> | null;
    default_profile_id: string;
    default_profile_source: string;
    default_profile_slug: string;
    default_profile_external_id: string | null;
  }> = await ds.query(
    `
    SELECT
      t.id                       AS tenant_id,
      t.workspace_id             AS workspace_id,
      t.external_id              AS tenant_external_id,
      t.name                     AS tenant_name,
      cb.id                      AS business_id,
      cb.display_name            AS business_display_name,
      cb.metadata                AS business_metadata,
      cp.id                      AS default_profile_id,
      cp.source                  AS default_profile_source,
      cp.slug                    AS default_profile_slug,
      cp.external_profile_id     AS default_profile_external_id
    FROM tenants t
    JOIN communication_businesses cb
      ON cb.tenant_id = t.id
    JOIN communication_profiles cp
      ON cp.communication_business_id = cb.id
     AND cp.is_default = TRUE
    WHERE cp.source = 'leadbridge'
    ${where}
    `,
    params,
  );

  if (rows.length === 0) return [];

  // Pull active phone assignments for these default profiles in one query.
  const profileIds = rows.map((r) => r.default_profile_id);
  const ppaRows: Array<{ id: string; profile_id: string }> = await ds.query(
    `
    SELECT id, profile_id
      FROM profile_phone_assignments
     WHERE profile_id = ANY($1::uuid[])
       AND active = TRUE
    `,
    [profileIds],
  );
  const ppaByProfile = new Map<string, string[]>();
  for (const r of ppaRows) {
    const arr = ppaByProfile.get(r.profile_id) ?? [];
    arr.push(r.id);
    ppaByProfile.set(r.profile_id, arr);
  }

  return rows.map((r) => ({
    tenantId: r.tenant_id,
    workspaceId: r.workspace_id,
    tenantExternalId: r.tenant_external_id,
    tenantName: r.tenant_name,
    businessId: r.business_id,
    businessDisplayName: r.business_display_name,
    businessMetadata: r.business_metadata,
    defaultProfileId: r.default_profile_id,
    defaultProfileSource: r.default_profile_source,
    defaultProfileSlug: r.default_profile_slug,
    defaultProfileExternalId: r.default_profile_external_id,
    activePhoneAssignmentIds: ppaByProfile.get(r.default_profile_id) ?? [],
  }));
}

// ---------------------------------------------------------------------------
// DB writes (per-tenant transaction)
// ---------------------------------------------------------------------------

type ExecuteResult = 'applied' | 'noop';

async function executePlan(
  qr: QueryRunner,
  plan: Extract<TenantPlan, { kind: 'apply' }>,
): Promise<ExecuteResult> {
  // (a) Update business display + metadata.
  await qr.query(
    `
    UPDATE communication_businesses
       SET display_name = $1,
           metadata     = $2::jsonb,
           updated_at   = now()
     WHERE id = $3
    `,
    [
      plan.businessUpdate.newDisplayName,
      JSON.stringify(plan.businessUpdate.newMetadata),
      plan.businessId,
    ],
  );

  // (b) Look up an existing source profile (idempotency).
  const existing: Array<{ id: string; is_default: boolean }> = await qr.query(
    `
    SELECT id, is_default
      FROM communication_profiles
     WHERE communication_business_id = $1
       AND source = $2
       AND external_profile_id = $3
     LIMIT 1
    `,
    [plan.businessId, plan.newProfile.platform, plan.newProfile.externalProfileId],
  );

  let newProfileId: string;
  let isNoop = false;

  if (existing.length > 0) {
    newProfileId = existing[0].id;
    // Already there — refresh display fields + ensure is_default=TRUE.
    if (existing[0].is_default) {
      isNoop = true;
    }
    // Demote ANY other default under this business first (constraint guard).
    await qr.query(
      `
      UPDATE communication_profiles
         SET is_default = FALSE,
             updated_at = now()
       WHERE communication_business_id = $1
         AND id <> $2
         AND is_default = TRUE
      `,
      [plan.businessId, newProfileId],
    );
    await qr.query(
      `
      UPDATE communication_profiles
         SET display_name = $1,
             slug         = $2,
             status       = 'active',
             is_default   = TRUE,
             metadata     = COALESCE(metadata,'{}'::jsonb)
                            || jsonb_build_object('lb_saved_account_id', $3::text),
             updated_at   = now()
       WHERE id = $4
      `,
      [
        plan.newProfile.displayName,
        plan.newProfile.slug,
        plan.newProfile.savedAccountId,
        newProfileId,
      ],
    );
  } else {
    // Demote the existing default before inserting the new is_default=TRUE row,
    // so the partial-unique index IDX_cp_business_default doesn't trip.
    await qr.query(
      `
      UPDATE communication_profiles
         SET is_default = FALSE,
             updated_at = now()
       WHERE id = $1
         AND is_default = TRUE
      `,
      [plan.defaultProfileId],
    );
    const inserted: Array<{ id: string }> = await qr.query(
      `
      INSERT INTO communication_profiles
        (workspace_id, tenant_id, communication_business_id,
         source, external_profile_id, display_name, slug,
         status, is_default, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', TRUE,
              jsonb_build_object('lb_saved_account_id', $8::text))
      RETURNING id
      `,
      [
        plan.workspaceId,
        plan.tenantId,
        plan.businessId,
        plan.newProfile.platform,
        plan.newProfile.externalProfileId,
        plan.newProfile.displayName,
        plan.newProfile.slug,
        plan.newProfile.savedAccountId,
      ],
    );
    newProfileId = inserted[0].id;
  }

  // (c) Repoint ACTIVE phone assignments from the old default to the new profile.
  //     Inactive PPAs stay on the old default for forensic continuity.
  if (plan.phoneAssignmentIdsToMove.length > 0) {
    await qr.query(
      `
      UPDATE profile_phone_assignments
         SET profile_id = $1,
             updated_at = now()
       WHERE id = ANY($2::uuid[])
         AND active = TRUE
      `,
      [newProfileId, plan.phoneAssignmentIdsToMove],
    );
  }

  // (d) Pin business.default_profile_id to the new profile.
  await qr.query(
    `
    UPDATE communication_businesses
       SET default_profile_id = $1, updated_at = now()
     WHERE id = $2 AND default_profile_id IS DISTINCT FROM $1
    `,
    [newProfileId, plan.businessId],
  );

  return isNoop ? 'noop' : 'applied';
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printPlanSummary(plans: TenantPlan[]): void {
  const apply = plans.filter((p) => p.kind === 'apply') as Array<
    Extract<TenantPlan, { kind: 'apply' }>
  >;
  const skip = plans.filter((p) => p.kind === 'skip') as Array<
    Extract<TenantPlan, { kind: 'skip' }>
  >;

  log(`\nPlan summary:`);
  log(`  actionable: ${apply.length}`);
  log(`  skipped:    ${skip.length}`);

  if (apply.length > 0) {
    log(`\nPer-tenant plan:`);
    for (const p of apply) {
      log(
        `  [tenant ${shortId(p.tenantId)}] biz="${p.businessUpdate.newDisplayName}" ` +
          `loc=${p.location.key}(${p.location.source}) ` +
          `→ profile ${p.newProfile.platform}/${p.newProfile.displayName} ` +
          `(slug=${p.newProfile.slug}, ext=${p.newProfile.externalProfileId}) ` +
          `phones=${p.phoneAssignmentIdsToMove.length}`,
      );
    }
  }

  if (skip.length > 0) {
    log(`\nSkipped:`);
    for (const s of skip) {
      log(`  [tenant ${shortId(s.tenantId)}] ${s.reason}${s.detail ? ` — ${s.detail}` : ''}`);
    }
  }

  // Per-location-source counts (curated vs suffix-strip vs brand fallback).
  const bySource = { curated: 0, suffix_strip: 0, brand_fallback: 0 };
  for (const p of apply) bySource[p.location.source]++;
  log(
    `\nLocation provenance: curated=${bySource.curated}, ` +
      `suffix_strip=${bySource.suffix_strip}, brand_fallback=${bySource.brand_fallback}`,
  );
}

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
