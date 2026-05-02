/**
 * Pure helpers for the LeadBridge conversation backfill script (PR7).
 *
 * The backfill moves existing communication_conversations from the demoted
 * "Default" profile (kept after PR6) to the real Thumbtack/Yelp profile that
 * now owns the conversation's phone number.
 *
 * Resolution path (mirrors the live inbound resolver, but read-only on the
 * conversation side):
 *
 *   conversation.phone_number
 *     → tenant_phone_numbers (matched on tenant_id + phone_number)
 *     → profile_phone_assignments (active=TRUE)
 *     → ORDER BY (is_default DESC, priority DESC) → new profile_id
 *
 * The helpers here own:
 *   - per-tenant target discovery (which old default → which new profile set)
 *   - the SQL the executor will run
 *   - the report summary
 *
 * Pure — no I/O. The executor (lb-backfill-conversation-profiles.ts)
 * handles DataSource, transactions, and console output.
 */

export interface BackfillTenantTarget {
  tenantId: string;
  /** UUID of the demoted communication_profiles row (slug='default', is_default=FALSE). */
  oldDefaultProfileId: string;
  /** Tenant display name — for the dry-run report only. */
  tenantName: string | null;
  /** Workspace id — for log lines and per-tenant filtering. */
  workspaceId: string;
}

export interface BackfillTenantResult {
  tenantId: string;
  /** Conversations on the old default that we successfully repointed. */
  moved: number;
  /**
   * Conversations on the old default that we could NOT repoint because no
   * active PPA exists for their phone (left in place for manual review).
   */
  unresolved: number;
  /**
   * Total conversations that were already on the new profile (idempotent
   * re-runs report 0 here when fully migrated).
   */
  alreadyMigrated: number;
}

export interface BackfillRunSummary {
  tenantsProcessed: number;
  tenantsSkipped: number;
  totalMoved: number;
  totalUnresolved: number;
  totalAlreadyMigrated: number;
  failures: Array<{ tenantId: string; error: string }>;
}

/**
 * The single UPDATE statement the executor runs per tenant.
 *
 * We do this in a CTE so the join logic stays readable: each conversation
 * gets exactly one row in the CTE (DISTINCT ON), the row with the highest
 * (is_default, priority) for the conversation's phone among ACTIVE
 * assignments. Conversations whose phone has no active PPA are not in the
 * CTE and therefore left untouched (counted as "unresolved").
 *
 * Idempotency: the WHERE filter `communication_profile_id = $2` (old
 * default id) excludes any conversation we already moved in a prior run.
 *
 * Returns the moved-count via RETURNING.
 */
export function buildBackfillSql(): string {
  return `
    WITH conv_to_new_profile AS (
      SELECT DISTINCT ON (c.id)
             c.id          AS conv_id,
             ppa.profile_id AS new_profile_id,
             p.communication_business_id AS new_business_id
        FROM communication_conversations c
        JOIN tenant_phone_numbers tpn
          ON tpn.tenant_id = c.tenant_id
         AND tpn.phone_number = c.phone_number
        JOIN profile_phone_assignments ppa
          ON ppa.tenant_phone_number_id = tpn.id
         AND ppa.active = TRUE
        JOIN communication_profiles p
          ON p.id = ppa.profile_id
       WHERE c.tenant_id = $1
         AND c.communication_profile_id = $2
       ORDER BY c.id, ppa.is_default DESC, ppa.priority DESC
    )
    UPDATE communication_conversations c
       SET communication_profile_id = ctp.new_profile_id,
           communication_business_id = COALESCE(c.communication_business_id, ctp.new_business_id),
           profile_confidence = 'backfill',
           updated_at = now()
      FROM conv_to_new_profile ctp
     WHERE c.id = ctp.conv_id
       AND c.communication_profile_id = $2
    RETURNING c.id
  `;
}

/**
 * Counts the conversations still on the old default profile after the
 * UPDATE — these are the "unresolved" rows whose phone had no active PPA.
 *
 * Run inside the same transaction so the count reflects post-update state.
 */
export function buildUnresolvedCountSql(): string {
  return `
    SELECT COUNT(*)::int AS count
      FROM communication_conversations c
     WHERE c.tenant_id = $1
       AND c.communication_profile_id = $2
  `;
}

/**
 * Counts conversations that have ALREADY been moved off the old default
 * (i.e. no longer match `communication_profile_id = $2`). Reported as the
 * "already migrated" baseline so re-runs are obviously no-ops.
 *
 * We measure this by counting conversations under the tenant whose
 * profile_confidence = 'backfill' — that confidence value is only ever
 * written by this script, so it's a safe marker.
 */
export function buildAlreadyMigratedCountSql(): string {
  return `
    SELECT COUNT(*)::int AS count
      FROM communication_conversations c
     WHERE c.tenant_id = $1
       AND c.profile_confidence = 'backfill'
  `;
}

/**
 * Compose a one-line report for a per-tenant run.
 */
export function formatTenantResult(r: BackfillTenantResult, tenantName: string | null): string {
  const label = tenantName ? `"${tenantName}"` : '<no name>';
  return (
    `[tenant ${shortId(r.tenantId)} ${label}] moved=${r.moved} ` +
    `unresolved=${r.unresolved} already=${r.alreadyMigrated}`
  );
}

/**
 * Aggregate per-tenant results into a run summary.
 */
export function buildRunSummary(
  perTenant: Array<{ result: BackfillTenantResult; failure?: string }>,
  tenantsSkipped: number,
): BackfillRunSummary {
  const summary: BackfillRunSummary = {
    tenantsProcessed: 0,
    tenantsSkipped,
    totalMoved: 0,
    totalUnresolved: 0,
    totalAlreadyMigrated: 0,
    failures: [],
  };
  for (const entry of perTenant) {
    if (entry.failure) {
      summary.failures.push({ tenantId: entry.result.tenantId, error: entry.failure });
      continue;
    }
    summary.tenantsProcessed++;
    summary.totalMoved += entry.result.moved;
    summary.totalUnresolved += entry.result.unresolved;
    summary.totalAlreadyMigrated += entry.result.alreadyMigrated;
  }
  return summary;
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/**
 * Normalize the result of a TypeORM `QueryRunner.query()` for an
 * UPDATE...RETURNING (or similar) statement.
 *
 * TypeORM 0.3.x with the postgres driver returns the rows array directly for
 * SELECT and most INSERT...RETURNING calls, but for CTE-wrapped
 * UPDATE...RETURNING the underlying pg driver may surface a `[rows, info]`
 * tuple (length 2, where index 0 is the rows array). Treating the result
 * with `.length` directly silently reports `2` instead of the real row count.
 *
 * This helper detects the tuple shape and unwraps it; otherwise it returns
 * the input as-is (still typed as an array of T).
 *
 * Pure — no I/O. Unit-tested via the helpers spec.
 */
export function extractReturningRows<T>(result: unknown): T[] {
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    Array.isArray(result[0]) &&
    !Array.isArray(result[1])
  ) {
    return result[0] as T[];
  }
  if (Array.isArray(result)) return result as T[];
  return [];
}
