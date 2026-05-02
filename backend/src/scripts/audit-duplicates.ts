/**
 * Sigcore duplicate audit (PR9) — AUDIT ONLY, NO WRITES.
 *
 * Reads tenants, communication_businesses, communication_profiles, and the
 * surrounding wiring (phones, conversations, api_keys, webhook_subscriptions,
 * endpoint_routes) from the configured DATABASE_URL. Identifies duplicate
 * groups at three levels:
 *
 *   tenant   — multiple tenant rows for the same logical customer
 *   business — multiple businesses for the same workspace + location
 *   profile  — multiple profiles for the same business + source + external id
 *
 * For each group it:
 *   - selects the canonical record using locked rules (see helpers spec)
 *   - tags every other record with a recommended action and safe_to_delete
 *   - exports the full report to JSON (and a one-line-per-record summary)
 *
 * **There is no --apply flag. There is no DRY_RUN flag. This script never
 * writes.** Cleanup actions referenced in the report (deactivate_zombie,
 * soft_disable_duplicate, etc.) are executed by separate cleanup scripts
 * that land in later PRs.
 *
 * Usage (from backend/):
 *   DATABASE_URL=... npm run audit:duplicates -- --output=./audit.json
 *   npm run audit:duplicates -- --input=./lb-saved-accounts.json --output=./audit.json
 *
 * --input             optional: LB SavedAccount export to compute hasSavedAccount
 *                     accurately. When omitted, every tenant is treated as
 *                     "no SavedAccount" (over-reports zombies — narrow the
 *                     report by always passing --input).
 * --output            output JSON path (default: ./audit-duplicates.json)
 * --include-singletons   include groups with size 1 in the JSON output
 *                        (useful for full inventory; default off)
 */

import 'reflect-metadata';
import { config as loadDotEnv } from 'dotenv';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, resolve as resolvePath } from 'path';
import { DataSource } from 'typeorm';

import {
  AuditBusinessRow,
  AuditProfileRow,
  AuditTenantRow,
  DuplicateRecord,
  TenantSignatureInputs,
  businessLocationSignature,
  groupBusinessesForDuplicates,
  groupProfilesForDuplicates,
  groupTenantsBySignature,
  isPlatformAnchor,
  isZombieTenant,
  pickBestLocationFromBusinesses,
  pickBestSourceFromProfiles,
  recommendTenantAction,
  selectCanonicalBusiness,
  selectCanonicalProfile,
  selectCanonicalTenant,
  tenantSignature,
} from './audit-duplicates.helpers';
// Reuse the existing platform attribution helper to derive platformId.
import {
  attributePlatforms,
  AttributionTenant,
} from '../modules/admin-views/platform-attribution';

loadDotEnv();

interface CliArgs {
  input?: string;
  output: string;
  includeSingletons: boolean;
}

function parseArgv(argv: string[]): CliArgs {
  const args: CliArgs = {
    output: './audit-duplicates.json',
    includeSingletons: false,
  };
  for (const a of argv) {
    if (a.startsWith('--input=')) args.input = a.slice('--input='.length);
    else if (a.startsWith('--output=')) args.output = a.slice('--output='.length);
    else if (a === '--include-singletons') args.includeSingletons = true;
  }
  return args;
}

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
// DB reads
// ---------------------------------------------------------------------------

interface SavedAccountSubset {
  id: string;
}

async function loadAuditData(
  ds: DataSource,
  savedAccountIds: Set<string>,
): Promise<{
  tenants: AuditTenantRow[];
  businesses: AuditBusinessRow[];
  profiles: AuditProfileRow[];
  lbUserIdByTenantId: Map<string, string>;
  workspaceKeyByBusinessId: Map<string, string>;
  signatureByTenantId: Map<string, string>;
  signatureInputsByTenantId: Map<string, TenantSignatureInputs>;
}> {
  // ---- tenants + per-tenant counts in one bundle ----
  const tenantRows: Array<{
    id: string;
    workspace_id: string;
    external_id: string | null;
    name: string | null;
    status: string | null;
  }> = await ds.query(
    `SELECT id, workspace_id, external_id, name, status FROM tenants`,
  );

  // Most-recent conversation per tenant + counts.
  const convAgg: Array<{ tenant_id: string; count: number; latest: Date | null }> =
    await ds.query(
      `SELECT tenant_id::text AS tenant_id,
              COUNT(*)::int AS count,
              MAX(created_at) AS latest
         FROM communication_conversations
        WHERE tenant_id IS NOT NULL
        GROUP BY tenant_id`,
    );
  const convByTenant = new Map<string, { count: number; latest: Date | null }>();
  for (const r of convAgg) {
    convByTenant.set(r.tenant_id, {
      count: r.count,
      latest: r.latest ? new Date(r.latest) : null,
    });
  }

  const apiKeyAgg: Array<{ tenant_id: string; count: number }> = await ds.query(
    `SELECT tenant_id::text AS tenant_id, COUNT(*)::int AS count
       FROM api_keys WHERE tenant_id IS NOT NULL GROUP BY tenant_id`,
  );
  const apiKeysByTenant = new Map(apiKeyAgg.map((r) => [r.tenant_id, r.count]));

  const wsubAgg: Array<{ tenant_id: string; count: number }> = await ds.query(
    `SELECT tenant_id::text AS tenant_id, COUNT(*)::int AS count
       FROM webhook_subscriptions WHERE tenant_id IS NOT NULL GROUP BY tenant_id`,
  );
  const wsubByTenant = new Map(wsubAgg.map((r) => [r.tenant_id, r.count]));

  const erAgg: Array<{ tenant_id: string; count: number }> = await ds.query(
    `SELECT tenant_id::text AS tenant_id, COUNT(*)::int AS count
       FROM endpoint_routes WHERE tenant_id IS NOT NULL GROUP BY tenant_id`,
  );
  const erByTenant = new Map(erAgg.map((r) => [r.tenant_id, r.count]));

  const phoneAgg: Array<{ tenant_id: string; count: number }> = await ds.query(
    `SELECT tenant_id::text AS tenant_id, COUNT(*)::int AS count
       FROM tenant_phone_numbers WHERE tenant_id IS NOT NULL GROUP BY tenant_id`,
  );
  const phonesByTenant = new Map(phoneAgg.map((r) => [r.tenant_id, r.count]));

  const tenants: AuditTenantRow[] = tenantRows.map((t) => {
    const conv = convByTenant.get(t.id) ?? { count: 0, latest: null };
    return {
      id: t.id,
      workspaceId: t.workspace_id,
      externalId: t.external_id,
      name: t.name,
      status: t.status,
      hasSavedAccount: t.external_id ? savedAccountIds.has(t.external_id) : false,
      latestActivityAt: conv.latest,
      conversationCount: conv.count,
      apiKeyCount: apiKeysByTenant.get(t.id) ?? 0,
      webhookSubscriptionCount: wsubByTenant.get(t.id) ?? 0,
      endpointRouteCount: erByTenant.get(t.id) ?? 0,
      phoneNumberCount: phonesByTenant.get(t.id) ?? 0,
    };
  });

  // ---- businesses ----
  const bizRows: Array<{
    id: string;
    workspace_id: string;
    tenant_id: string;
    display_name: string;
    slug: string;
    status: string | null;
    external_business_id: string | null;
    metadata: Record<string, unknown> | null;
  }> = await ds.query(
    `SELECT id, workspace_id, tenant_id, display_name, slug, status,
            external_business_id, metadata
       FROM communication_businesses`,
  );

  // Active phone assignments + profile counts per business.
  const ppaPerBiz: Array<{ business_id: string; count: number }> = await ds.query(
    `SELECT p.communication_business_id::text AS business_id,
            COUNT(*)::int AS count
       FROM profile_phone_assignments ppa
       JOIN communication_profiles p ON p.id = ppa.profile_id
      WHERE ppa.active = TRUE
      GROUP BY p.communication_business_id`,
  );
  const ppaByBiz = new Map(ppaPerBiz.map((r) => [r.business_id, r.count]));

  const profilesPerBiz: Array<{ business_id: string; count: number }> = await ds.query(
    `SELECT communication_business_id::text AS business_id, COUNT(*)::int AS count
       FROM communication_profiles GROUP BY communication_business_id`,
  );
  const profileCountByBiz = new Map(profilesPerBiz.map((r) => [r.business_id, r.count]));

  const businesses: AuditBusinessRow[] = bizRows.map((b) => ({
    id: b.id,
    workspaceId: b.workspace_id,
    tenantId: b.tenant_id,
    displayName: b.display_name,
    slug: b.slug,
    status: b.status,
    externalBusinessId: b.external_business_id,
    metadata: b.metadata,
    activePhoneAssignments: ppaByBiz.get(b.id) ?? 0,
    profileCount: profileCountByBiz.get(b.id) ?? 0,
  }));

  // ---- profiles ----
  const profileRows: Array<{
    id: string;
    communication_business_id: string;
    tenant_id: string;
    source: string;
    external_profile_id: string | null;
    display_name: string;
    slug: string;
    is_default: boolean;
    status: string | null;
  }> = await ds.query(
    `SELECT id, communication_business_id, tenant_id, source,
            external_profile_id, display_name, slug, is_default, status
       FROM communication_profiles`,
  );

  const ppaPerProfile: Array<{ profile_id: string; count: number }> = await ds.query(
    `SELECT profile_id::text AS profile_id, COUNT(*)::int AS count
       FROM profile_phone_assignments
      WHERE active = TRUE
      GROUP BY profile_id`,
  );
  const ppaByProfile = new Map(ppaPerProfile.map((r) => [r.profile_id, r.count]));

  const profiles: AuditProfileRow[] = profileRows.map((p) => ({
    id: p.id,
    communicationBusinessId: p.communication_business_id,
    tenantId: p.tenant_id,
    source: p.source,
    externalProfileId: p.external_profile_id,
    displayName: p.display_name,
    slug: p.slug,
    isDefault: p.is_default,
    status: p.status,
    activePhoneAssignments: ppaByProfile.get(p.id) ?? 0,
  }));

  // ---- derived: lb_user_id per tenant + workspace key per business ----
  const lbUserIdByTenantId = new Map<string, string>();
  const workspaceKeyByBusinessId = new Map<string, string>();
  for (const b of businesses) {
    const meta = b.metadata ?? {};
    const lbUserId =
      typeof meta.lb_user_id === 'string' && meta.lb_user_id.trim()
        ? (meta.lb_user_id as string).trim()
        : null;
    if (lbUserId) {
      lbUserIdByTenantId.set(b.tenantId, lbUserId);
      workspaceKeyByBusinessId.set(b.id, `lb-user-${lbUserId}`);
    } else {
      workspaceKeyByBusinessId.set(b.id, `tenant-${b.tenantId}`);
    }
  }

  // ---- PR9.1: per-tenant signature (platform + customer + location + source) ----
  const businessesByTenantId = new Map<string, AuditBusinessRow[]>();
  for (const b of businesses) {
    const arr = businessesByTenantId.get(b.tenantId) ?? [];
    arr.push(b);
    businessesByTenantId.set(b.tenantId, arr);
  }
  const profilesByTenantId = new Map<string, AuditProfileRow[]>();
  for (const p of profiles) {
    const arr = profilesByTenantId.get(p.tenantId) ?? [];
    arr.push(p);
    profilesByTenantId.set(p.tenantId, arr);
  }
  const attribution = attributePlatforms(
    tenants.map<AttributionTenant>((t) => ({ id: t.id, name: t.name ?? '' })),
  );
  const signatureByTenantId = new Map<string, string>();
  const signatureInputsByTenantId = new Map<string, TenantSignatureInputs>();
  for (const t of tenants) {
    const tBiz = businessesByTenantId.get(t.id) ?? [];
    const tProf = profilesByTenantId.get(t.id) ?? [];
    const loc = pickBestLocationFromBusinesses(tBiz);
    const src = pickBestSourceFromProfiles(tProf);
    const inputs: TenantSignatureInputs = {
      platformId: attribution.byTenantId.get(t.id) ?? 'unclassified',
      lbUserId: lbUserIdByTenantId.get(t.id) ?? null,
      curatedLocation: loc.curated,
      fallbackLocationName: loc.fallback,
      bestRealSource: src.real,
      defaultSource: src.defaulted,
    };
    signatureInputsByTenantId.set(t.id, inputs);
    signatureByTenantId.set(t.id, tenantSignature(t, inputs));
  }

  return {
    tenants,
    businesses,
    profiles,
    lbUserIdByTenantId,
    workspaceKeyByBusinessId,
    signatureByTenantId,
    signatureInputsByTenantId,
  };
}

// ---------------------------------------------------------------------------
// Report builders
// ---------------------------------------------------------------------------

interface ReportTenantGroup {
  signature: string;
  size: number;
  canonicalId: string | null;
  records: Array<DuplicateRecord & { row: AuditTenantRow }>;
}

interface ReportBusinessGroup {
  signature: string;
  size: number;
  canonicalId: string | null;
  records: Array<DuplicateRecord & { row: AuditBusinessRow }>;
}

interface ReportProfileGroup {
  signature: string;
  size: number;
  canonicalId: string | null;
  records: Array<DuplicateRecord & { row: AuditProfileRow }>;
}

interface AuditReport {
  generatedAt: string;
  inputs: {
    savedAccountCount: number;
    tenantCount: number;
    businessCount: number;
    profileCount: number;
  };
  summary: {
    tenantGroups: { total: number; multi: number };
    businessGroups: { total: number; multi: number };
    profileGroups: { total: number; multi: number };
    actions: Record<string, number>;
    safeToDeleteCount: number;
    manualReviewCount: number;
    anchorTenantCount: number;
    zombieTenantCount: number;
  };
  tenantGroups: ReportTenantGroup[];
  businessGroups: ReportBusinessGroup[];
  profileGroups: ReportProfileGroup[];
}

function buildTenantGroups(
  tenants: AuditTenantRow[],
  lbUserIdByTenantId: Map<string, string>,
  signatureByTenantId: Map<string, string>,
  signatureInputsByTenantId: Map<string, TenantSignatureInputs>,
  includeSingletons: boolean,
): ReportTenantGroup[] {
  const groups = groupTenantsBySignature(tenants, signatureByTenantId);
  const out: ReportTenantGroup[] = [];
  for (const [signature, rows] of groups) {
    if (!includeSingletons && rows.length < 2) continue;
    const canonicalId = selectCanonicalTenant(rows);
    const canonical = canonicalId ? rows.find((r) => r.id === canonicalId) ?? null : null;
    const groupSize = rows.length;
    const records = rows
      .map((row) => {
        const rec = recommendTenantAction(row, canonical, groupSize);
        const inputs = signatureInputsByTenantId.get(row.id);
        const out: DuplicateRecord & { row: AuditTenantRow } = {
          recordType: 'tenant',
          recordId: row.id,
          isCanonical: canonicalId === row.id,
          recommendedAction: rec.action,
          safeToDelete: rec.safeToDelete,
          reason: rec.reason,
          dimensions: {
            externalId: row.externalId,
            lbUserId: lbUserIdByTenantId.get(row.id) ?? null,
            name: row.name,
            hasSavedAccount: row.hasSavedAccount,
            isAnchor: isPlatformAnchor(row),
            isZombie: isZombieTenant(row),
            phones: row.phoneNumberCount,
            conversations: row.conversationCount,
            latestActivityAt: row.latestActivityAt
              ? row.latestActivityAt.toISOString()
              : null,
            apiKeys: row.apiKeyCount,
            webhookSubscriptions: row.webhookSubscriptionCount,
            endpointRoutes: row.endpointRouteCount,
            tenantSignature: signature,
            // PR9.1 — surface the dimensions that produced the signature so
            // operators can verify why two records did/didn't cluster.
            signaturePlatform: inputs?.platformId ?? null,
            signatureCustomer: inputs?.lbUserId
              ? `lb-user:${inputs.lbUserId}`
              : `ext:${row.externalId ?? row.id}`,
            signatureLocation:
              inputs?.curatedLocation ??
              (inputs?.fallbackLocationName ?? null),
            signatureSource:
              inputs?.bestRealSource ?? inputs?.defaultSource ?? null,
          },
          row,
        };
        return out;
      })
      .sort((a, b) =>
        a.isCanonical === b.isCanonical ? 0 : a.isCanonical ? -1 : 1,
      );
    out.push({ signature, size: rows.length, canonicalId, records });
  }
  // Stable order: multi-record groups first, then by signature.
  out.sort((a, b) => {
    if (a.size !== b.size) return b.size - a.size;
    return a.signature.localeCompare(b.signature);
  });
  return out;
}

function buildBusinessGroups(
  businesses: AuditBusinessRow[],
  workspaceKeyByBusinessId: Map<string, string>,
  includeSingletons: boolean,
): ReportBusinessGroup[] {
  const groups = groupBusinessesForDuplicates(businesses, workspaceKeyByBusinessId);
  const out: ReportBusinessGroup[] = [];
  for (const [signature, rows] of groups) {
    if (!includeSingletons && rows.length < 2) continue;
    const canonicalId = selectCanonicalBusiness(rows);
    const records = rows
      .map((row) => {
        const isCanonical = canonicalId === row.id;
        const meta = row.metadata ?? {};
        const lbUserId =
          typeof meta.lb_user_id === 'string' ? (meta.lb_user_id as string) : null;
        const location =
          typeof meta.location === 'string' ? (meta.location as string) : null;
        const out: DuplicateRecord & { row: AuditBusinessRow } = {
          recordType: 'business',
          recordId: row.id,
          isCanonical,
          recommendedAction: isCanonical
            ? 'keep_canonical'
            : 'soft_disable_duplicate',
          safeToDelete: !isCanonical && row.activePhoneAssignments === 0,
          reason: isCanonical
            ? 'canonical record'
            : `duplicate of ${canonicalId}; ${
                row.activePhoneAssignments === 0
                  ? 'no active phone assignments'
                  : 'has active phone assignments — repoint before delete'
              }`,
          dimensions: {
            tenantId: row.tenantId,
            displayName: row.displayName,
            slug: row.slug,
            externalBusinessId: row.externalBusinessId,
            lbUserId,
            location,
            workspaceKey: workspaceKeyByBusinessId.get(row.id) ?? null,
            profileCount: row.profileCount,
            activePhoneAssignments: row.activePhoneAssignments,
            locationSignature: businessLocationSignature(row),
          },
          row,
        };
        return out;
      })
      .sort((a, b) =>
        a.isCanonical === b.isCanonical ? 0 : a.isCanonical ? -1 : 1,
      );
    out.push({ signature, size: rows.length, canonicalId, records });
  }
  out.sort((a, b) => {
    if (a.size !== b.size) return b.size - a.size;
    return a.signature.localeCompare(b.signature);
  });
  return out;
}

function buildProfileGroups(
  profiles: AuditProfileRow[],
  includeSingletons: boolean,
): ReportProfileGroup[] {
  const groups = groupProfilesForDuplicates(profiles);
  const out: ReportProfileGroup[] = [];
  for (const [signature, rows] of groups) {
    if (!includeSingletons && rows.length < 2) continue;
    const canonicalId = selectCanonicalProfile(rows);
    const records = rows
      .map((row) => {
        const isCanonical = canonicalId === row.id;
        const out: DuplicateRecord & { row: AuditProfileRow } = {
          recordType: 'profile',
          recordId: row.id,
          isCanonical,
          recommendedAction: isCanonical
            ? 'keep_canonical'
            : 'soft_disable_duplicate',
          safeToDelete: !isCanonical && row.activePhoneAssignments === 0,
          reason: isCanonical
            ? 'canonical record'
            : `duplicate of ${canonicalId}; ${
                row.activePhoneAssignments === 0
                  ? 'no active phone assignments'
                  : 'has active phone assignments — repoint before delete'
              }`,
          dimensions: {
            tenantId: row.tenantId,
            communicationBusinessId: row.communicationBusinessId,
            source: row.source,
            externalProfileId: row.externalProfileId,
            slug: row.slug,
            displayName: row.displayName,
            isDefault: row.isDefault,
            status: row.status,
            activePhoneAssignments: row.activePhoneAssignments,
          },
          row,
        };
        return out;
      })
      .sort((a, b) =>
        a.isCanonical === b.isCanonical ? 0 : a.isCanonical ? -1 : 1,
      );
    out.push({ signature, size: rows.length, canonicalId, records });
  }
  out.sort((a, b) => {
    if (a.size !== b.size) return b.size - a.size;
    return a.signature.localeCompare(b.signature);
  });
  return out;
}

function summarize(
  tenantGroups: ReportTenantGroup[],
  businessGroups: ReportBusinessGroup[],
  profileGroups: ReportProfileGroup[],
  tenants: AuditTenantRow[],
): AuditReport['summary'] {
  const actions: Record<string, number> = {};
  let safeToDeleteCount = 0;
  let manualReviewCount = 0;
  for (const groups of [tenantGroups, businessGroups, profileGroups]) {
    for (const g of groups) {
      for (const r of g.records) {
        actions[r.recommendedAction] = (actions[r.recommendedAction] ?? 0) + 1;
        if (r.safeToDelete) safeToDeleteCount++;
        if (r.recommendedAction === 'manual_review') manualReviewCount++;
      }
    }
  }
  return {
    tenantGroups: {
      total: tenantGroups.length,
      multi: tenantGroups.filter((g) => g.size > 1).length,
    },
    businessGroups: {
      total: businessGroups.length,
      multi: businessGroups.filter((g) => g.size > 1).length,
    },
    profileGroups: {
      total: profileGroups.length,
      multi: profileGroups.filter((g) => g.size > 1).length,
    },
    actions,
    safeToDeleteCount,
    manualReviewCount,
    anchorTenantCount: tenants.filter(isPlatformAnchor).length,
    zombieTenantCount: tenants.filter(isZombieTenant).length,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgv(process.argv.slice(2));

  // Optional SavedAccount input → set of LB SavedAccount ids → hasSavedAccount.
  let savedAccountIds = new Set<string>();
  if (args.input) {
    if (!existsSync(args.input)) {
      throw new Error(`--input file not found: ${args.input}`);
    }
    const raw = readFileSync(resolvePath(args.input), 'utf-8');
    const arr = JSON.parse(raw) as SavedAccountSubset[];
    if (!Array.isArray(arr)) {
      throw new Error('--input must be a JSON array');
    }
    savedAccountIds = new Set(arr.map((sa) => sa.id));
  }

  const ds = buildDataSource();
  await ds.initialize();
  let report: AuditReport;
  try {
    const data = await loadAuditData(ds, savedAccountIds);
    const tenantGroups = buildTenantGroups(
      data.tenants,
      data.lbUserIdByTenantId,
      data.signatureByTenantId,
      data.signatureInputsByTenantId,
      args.includeSingletons,
    );
    const businessGroups = buildBusinessGroups(
      data.businesses,
      data.workspaceKeyByBusinessId,
      args.includeSingletons,
    );
    const profileGroups = buildProfileGroups(data.profiles, args.includeSingletons);

    report = {
      generatedAt: new Date().toISOString(),
      inputs: {
        savedAccountCount: savedAccountIds.size,
        tenantCount: data.tenants.length,
        businessCount: data.businesses.length,
        profileCount: data.profiles.length,
      },
      summary: summarize(tenantGroups, businessGroups, profileGroups, data.tenants),
      tenantGroups,
      businessGroups,
      profileGroups,
    };
  } finally {
    await ds.destroy();
  }

  // Write JSON report.
  const abs = resolvePath(args.output);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(report, null, 2) + '\n', 'utf-8');

  // Console summary.
  log(`\nDuplicate audit (read-only, no writes performed)`);
  log(`Inputs:`);
  log(`  saved accounts:       ${report.inputs.savedAccountCount}`);
  log(`  tenants:              ${report.inputs.tenantCount}`);
  log(`  businesses:           ${report.inputs.businessCount}`);
  log(`  profiles:             ${report.inputs.profileCount}`);
  log(`Groups (multi-record / total):`);
  log(`  tenants:              ${report.summary.tenantGroups.multi} / ${report.summary.tenantGroups.total}`);
  log(`  businesses:           ${report.summary.businessGroups.multi} / ${report.summary.businessGroups.total}`);
  log(`  profiles:             ${report.summary.profileGroups.multi} / ${report.summary.profileGroups.total}`);
  log(`Records by recommended action:`);
  for (const [action, count] of Object.entries(report.summary.actions).sort()) {
    log(`  ${action.padEnd(28)} ${count}`);
  }
  log(`Safe to delete (no traffic, no phones, no wiring): ${report.summary.safeToDeleteCount}`);
  log(`Manual review needed:                              ${report.summary.manualReviewCount}`);
  log(`Anchor tenants (must never be customer workspace): ${report.summary.anchorTenantCount}`);
  log(`Zombie tenants (no SavedAccount backing):          ${report.summary.zombieTenantCount}`);
  log(`\nFull report written to: ${abs}`);
  log(`No writes performed. This script never modifies data.`);
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
