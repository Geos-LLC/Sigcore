/**
 * Pure helpers for the duplicate-tenant repointing script (PR13).
 *
 * The script consumes the JSON report emitted by PR9's audit (`audit-duplicates.ts`)
 * and produces, for each non-canonical tenant, a "repoint plan" describing
 * which dependent rows to move to the canonical tenant. The script never
 * deletes, never deactivates, and never touches api_keys or
 * communication_messages directly (messages follow conversations via FK).
 *
 * These helpers are pure — no I/O, no DB. The executable owns the DataSource
 * and the per-tenant transaction.
 */

// ---------------------------------------------------------------------------
// Audit JSON shape (subset — what we actually read)
// ---------------------------------------------------------------------------

export interface AuditReportTenantRecordDimensions {
  isAnchor?: boolean;
  isZombie?: boolean;
  hasSavedAccount?: boolean;
  conversations?: number;
  phones?: number;
  apiKeys?: number;
  webhookSubscriptions?: number;
  endpointRoutes?: number;
  [k: string]: unknown;
}

export interface AuditReportRecord {
  recordType: 'tenant' | 'business' | 'profile';
  recordId: string;
  isCanonical: boolean;
  recommendedAction: string;
  safeToDelete: boolean;
  reason: string;
  dimensions: AuditReportTenantRecordDimensions;
}

export interface AuditReportTenantGroup {
  signature: string;
  size: number;
  canonicalId: string | null;
  records: AuditReportRecord[];
}

export interface AuditReport {
  generatedAt: string;
  tenantGroups: AuditReportTenantGroup[];
  /* Other top-level fields exist (businessGroups, summary, …) but PR13 only
     reads tenantGroups. Treat as opaque. */
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Plan shape
// ---------------------------------------------------------------------------

export interface RepointPlan {
  /** Tenant whose dependent rows will be repointed onto the canonical. */
  duplicateTenantId: string;
  /** Tenant the rows will land on. */
  canonicalTenantId: string;
  /** Audit signature that grouped these together — useful in the report. */
  groupSignature: string;
  /** Rationale for choosing this pair (carried verbatim from the audit). */
  duplicateAuditReason: string;
}

export type SkipReason =
  | 'no_canonical'
  | 'duplicate_is_anchor'
  | 'canonical_is_anchor'
  | 'self_repoint'
  | 'duplicate_not_in_group';

export interface SkippedPlan {
  duplicateTenantId: string;
  canonicalTenantId: string | null;
  groupSignature: string;
  reason: SkipReason;
  detail: string;
}

// ---------------------------------------------------------------------------
// Plan builder
// ---------------------------------------------------------------------------

export interface BuildPlanOptions {
  /** Limit to a single duplicate tenant id (for smoke testing). */
  tenantIdFilter?: string;
  /**
   * Cap the number of duplicates returned. Applied AFTER skip filtering so
   * `--limit=1` always returns 1 actionable plan when one exists.
   */
  limit?: number;
}

export interface BuildPlanResult {
  plans: RepointPlan[];
  skipped: SkippedPlan[];
}

/**
 * Walk the audit JSON's tenantGroups and emit `RepointPlan` records for every
 * non-canonical tenant in a multi-record group. Skips with structured reasons:
 *
 *   no_canonical              — group has no canonicalId (every record is anchor/zombie)
 *   duplicate_is_anchor       — refusing to process an anchor as a duplicate
 *   canonical_is_anchor       — defensive: audit should never have selected this, but verify
 *   self_repoint              — record is the canonical itself (skip silently — keep it)
 *   duplicate_not_in_group    — caller-passed tenant id isn't in any group
 *
 * Pure — no I/O.
 */
export function buildRepointPlans(
  audit: AuditReport,
  options: BuildPlanOptions = {},
): BuildPlanResult {
  const plans: RepointPlan[] = [];
  const skipped: SkippedPlan[] = [];
  let foundFilterMatch = false;

  for (const group of audit.tenantGroups ?? []) {
    if (group.size < 2) continue;

    if (!group.canonicalId) {
      for (const r of group.records) {
        if (r.recordType !== 'tenant') continue;
        if (options.tenantIdFilter && r.recordId !== options.tenantIdFilter) continue;
        if (options.tenantIdFilter) foundFilterMatch = true;
        skipped.push({
          duplicateTenantId: r.recordId,
          canonicalTenantId: null,
          groupSignature: group.signature,
          reason: 'no_canonical',
          detail: 'group has no canonical winner; manual_review required',
        });
      }
      continue;
    }

    const canonicalRecord = group.records.find(
      (r) => r.recordId === group.canonicalId,
    );
    if (canonicalRecord?.dimensions?.isAnchor) {
      for (const r of group.records) {
        if (r.recordType !== 'tenant') continue;
        if (options.tenantIdFilter && r.recordId !== options.tenantIdFilter) continue;
        if (options.tenantIdFilter) foundFilterMatch = true;
        skipped.push({
          duplicateTenantId: r.recordId,
          canonicalTenantId: group.canonicalId,
          groupSignature: group.signature,
          reason: 'canonical_is_anchor',
          detail: `audit chose canonical ${group.canonicalId} but it is flagged as anchor`,
        });
      }
      continue;
    }

    for (const r of group.records) {
      if (r.recordType !== 'tenant') continue;
      if (options.tenantIdFilter && r.recordId !== options.tenantIdFilter) continue;
      if (options.tenantIdFilter) foundFilterMatch = true;

      if (r.recordId === group.canonicalId) {
        // The canonical itself — not a plan, not a skip; just keep going.
        continue;
      }

      if (r.dimensions?.isAnchor) {
        skipped.push({
          duplicateTenantId: r.recordId,
          canonicalTenantId: group.canonicalId,
          groupSignature: group.signature,
          reason: 'duplicate_is_anchor',
          detail: 'refusing to repoint dependents off an anchor tenant',
        });
        continue;
      }

      plans.push({
        duplicateTenantId: r.recordId,
        canonicalTenantId: group.canonicalId,
        groupSignature: group.signature,
        duplicateAuditReason: r.reason,
      });
    }
  }

  if (options.tenantIdFilter && !foundFilterMatch) {
    skipped.push({
      duplicateTenantId: options.tenantIdFilter,
      canonicalTenantId: null,
      groupSignature: '<not-found>',
      reason: 'duplicate_not_in_group',
      detail: 'tenant id not present in any audit tenantGroup',
    });
  }

  if (typeof options.limit === 'number' && options.limit > 0) {
    return { plans: plans.slice(0, options.limit), skipped };
  }
  return { plans, skipped };
}

// ---------------------------------------------------------------------------
// Live-state validation (against repos)
// ---------------------------------------------------------------------------

export interface LiveTenantState {
  id: string;
  status: string | null;
  name: string | null;
  externalId: string | null;
  /** Defensive: re-check anchor status against the live row. */
  isAnchor: boolean;
}

export type ValidatePairFailure =
  | 'canonical_missing'
  | 'duplicate_missing'
  | 'self_repoint'
  | 'canonical_is_anchor_live'
  | 'duplicate_is_anchor_live';

export interface ValidatePairResult {
  ok: boolean;
  reason?: ValidatePairFailure;
  detail?: string;
}

/**
 * Final pre-write validation. The audit JSON is point-in-time; the caller
 * must re-check against current DB state in case zombies were cleaned up
 * manually or anchor flags changed.
 */
export function validateRepointPair(
  plan: RepointPlan,
  duplicate: LiveTenantState | null,
  canonical: LiveTenantState | null,
): ValidatePairResult {
  if (!duplicate) {
    return {
      ok: false,
      reason: 'duplicate_missing',
      detail: `duplicate tenant ${plan.duplicateTenantId} no longer exists`,
    };
  }
  if (!canonical) {
    return {
      ok: false,
      reason: 'canonical_missing',
      detail: `canonical tenant ${plan.canonicalTenantId} no longer exists`,
    };
  }
  if (duplicate.id === canonical.id) {
    return {
      ok: false,
      reason: 'self_repoint',
      detail: 'duplicate id equals canonical id',
    };
  }
  if (duplicate.isAnchor) {
    return {
      ok: false,
      reason: 'duplicate_is_anchor_live',
      detail: 'duplicate is an anchor — refusing to repoint',
    };
  }
  if (canonical.isAnchor) {
    return {
      ok: false,
      reason: 'canonical_is_anchor_live',
      detail: 'canonical is an anchor — refusing to repoint into it',
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Result reporting
// ---------------------------------------------------------------------------

export interface RepointResult {
  duplicateTenantId: string;
  canonicalTenantId: string;
  status: 'ready' | 'skipped' | 'error';
  phonesMoved: number;
  endpointRoutesMoved: number;
  webhookSubscriptionsMoved: number;
  conversationsChecked: number;
  conversationsFixed: number;
  skippedReason?: string;
  error?: string;
}

export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

export function formatRepointResultLine(r: RepointResult): string {
  const dup = shortId(r.duplicateTenantId);
  const can = shortId(r.canonicalTenantId);
  if (r.status === 'skipped') {
    return `[${dup} → ${can}] SKIPPED: ${r.skippedReason ?? 'no reason'}`;
  }
  if (r.status === 'error') {
    return `[${dup} → ${can}] ERROR: ${r.error ?? 'unknown'}`;
  }
  return (
    `[${dup} → ${can}] phones=${r.phonesMoved} ` +
    `routes=${r.endpointRoutesMoved} subs=${r.webhookSubscriptionsMoved} ` +
    `convs=${r.conversationsFixed}/${r.conversationsChecked}`
  );
}
