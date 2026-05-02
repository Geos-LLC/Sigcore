/**
 * Duplicate audit — pure helpers (PR9).
 *
 * Identifies same-customer / same-location / same-source duplicates across
 * tenants, communication_businesses, and communication_profiles. Computes
 * a canonical winner per group and a recommended action for each non-canonical
 * record.
 *
 * **AUDIT ONLY** — these helpers describe duplicates, they do not modify
 * anything. The executable script (audit-duplicates.ts) only emits a JSON
 * report. Cleanup scripts that act on the recommendations land in later PRs.
 *
 * Selection rules locked from the spec:
 *   1. Prefer tenant/business/profile with real LB SavedAccount backing
 *      (tenants whose external_id resolves to a known SavedAccount).
 *   2. Prefer the record with active phone assignments.
 *   3. Prefer most recent conversation activity.
 *   4. Prefer non-zombie tenant.
 *   5. Never choose the platform anchor tenant as customer workspace.
 *
 * Pure — no I/O.
 */

// ---------------------------------------------------------------------------
// Input row shapes (subset of DB rows the audit needs)
// ---------------------------------------------------------------------------

export interface AuditTenantRow {
  id: string;
  workspaceId: string;
  externalId: string | null;
  name: string | null;
  status: string | null;
  /** True when the tenant.external_id is in the LB SavedAccount export. */
  hasSavedAccount: boolean;
  /** Most recent communication_conversations.created_at for this tenant, or null. */
  latestActivityAt: Date | null;
  /** Total conversations under this tenant. */
  conversationCount: number;
  apiKeyCount: number;
  webhookSubscriptionCount: number;
  endpointRouteCount: number;
  phoneNumberCount: number;
}

export interface AuditBusinessRow {
  id: string;
  workspaceId: string;
  tenantId: string;
  displayName: string;
  slug: string;
  status: string | null;
  externalBusinessId: string | null;
  metadata: Record<string, unknown> | null;
  /** Total active profile_phone_assignments under this business. */
  activePhoneAssignments: number;
  /** Number of profiles under this business. */
  profileCount: number;
}

export interface AuditProfileRow {
  id: string;
  communicationBusinessId: string;
  tenantId: string;
  source: string;
  externalProfileId: string | null;
  displayName: string;
  slug: string;
  isDefault: boolean;
  status: string | null;
  /** Active assignments specifically for this profile. */
  activePhoneAssignments: number;
}

// ---------------------------------------------------------------------------
// Output row shapes
// ---------------------------------------------------------------------------

export type RecommendedAction =
  | 'keep_canonical'
  | 'soft_disable_duplicate'
  | 'deactivate_zombie'
  | 'flag_anchor_tenant'
  | 'manual_review';

export interface DuplicateRecord {
  recordType: 'tenant' | 'business' | 'profile';
  recordId: string;
  isCanonical: boolean;
  recommendedAction: RecommendedAction;
  safeToDelete: boolean;
  reason: string;
  /** Verbatim copy of the dimensions surfaced in the report row. */
  dimensions: Record<string, unknown>;
}

export interface DuplicateGroup<T> {
  /** Stable key — the signature this group was matched on. */
  signature: string;
  level: 'tenant' | 'business' | 'profile';
  /** The chosen canonical record id (may be null for orphan zombie groups). */
  canonicalId: string | null;
  records: Array<{ row: T; output: DuplicateRecord }>;
}

// ---------------------------------------------------------------------------
// Normalization + anchor detection
// ---------------------------------------------------------------------------

/**
 * Normalize a tenant/business name for grouping. Case-insensitive, collapses
 * whitespace, strips trailing/leading punctuation. "Spotless Homes Tampa  "
 * and "spotless homes tampa" hash to the same key.
 */
export function normalizeName(name: string | null | undefined): string {
  return (name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pattern: tenant.name "Account <uuid-or-hex>" — auto-generated stub used
 * when LB provisioned a tenant with no nicer label. These are not real
 * customer names; group purely by external_id when present.
 */
export function isAccountStubName(name: string | null | undefined): boolean {
  return /^account\s+[a-f0-9-]{8,}/i.test((name ?? '').trim());
}

/** Bootstrap anchor tenant names. Hard-coded from source-classifier.ts. */
const ANCHOR_NAME_NORMALIZED = new Set([
  'leadbridge',
  'service flow',
  'serviceflow',
  'callio',
  'hirefunnel',
]);

/**
 * Bootstrap anchor tenants exist purely as platform handles (e.g.,
 * tenants.name = "LeadBridge", external_id = "leadbridge-4xtm"). They
 * must never be selected as a customer workspace, even if they happen
 * to share a name with one.
 */
export function isPlatformAnchor(t: AuditTenantRow): boolean {
  if (ANCHOR_NAME_NORMALIZED.has(normalizeName(t.name))) return true;
  if (
    t.externalId &&
    /^(leadbridge|hirefunnel|serviceflow|callio)[-_]/i.test(t.externalId)
  ) {
    return true;
  }
  return false;
}

/**
 * A "zombie" tenant is one whose external_id has no matching LB SavedAccount.
 * Active LB tenants always have a SavedAccount; orphan/dead tenants do not.
 */
export function isZombieTenant(t: AuditTenantRow): boolean {
  return !t.hasSavedAccount && !isPlatformAnchor(t);
}

// ---------------------------------------------------------------------------
// Canonical selection
// ---------------------------------------------------------------------------

/**
 * Apply the canonical selection rules to a group of tenants and return the
 * canonical id, or null if the whole group is zombies/anchors with no
 * acceptable canonical.
 *
 * Rules in priority order:
 *   1. Has SavedAccount backing (real LB tenant)        — strongest signal
 *   2. Active phone assignments (still routing traffic)
 *   3. Most recent conversation activity
 *   4. Non-zombie (negative weight if zombie)
 *   5. Non-anchor (negative weight if anchor)
 *
 * Ties broken by tenant.id ascending (deterministic).
 */
export function selectCanonicalTenant(
  candidates: AuditTenantRow[],
): string | null {
  const realCandidates = candidates.filter((t) => !isPlatformAnchor(t));
  if (realCandidates.length === 0) return null;

  const scored = realCandidates.map((t) => ({
    t,
    score: scoreTenantForCanonical(t),
  }));
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.t.id.localeCompare(b.t.id);
  });
  const top = scored[0];
  // If the top candidate has score 0 (no positive signal), the whole group
  // is effectively dead — skip canonical assignment.
  return top.score > 0 ? top.t.id : null;
}

function scoreTenantForCanonical(t: AuditTenantRow): number {
  let score = 0;
  if (t.hasSavedAccount) score += 100;
  if (t.phoneNumberCount > 0) score += 30;
  if (t.conversationCount > 0) score += 20;
  if (t.apiKeyCount > 0) score += 5;
  if (t.endpointRouteCount > 0) score += 5;
  if (t.webhookSubscriptionCount > 0) score += 5;
  if (t.latestActivityAt) {
    // Recent activity bonus, decaying linearly over a year.
    const days = Math.max(
      0,
      (Date.now() - t.latestActivityAt.getTime()) / (1000 * 60 * 60 * 24),
    );
    score += Math.max(0, 50 - Math.floor(days / 7));
  }
  if (isPlatformAnchor(t)) score -= 10000;
  // No SavedAccount but with traffic = not zero, but de-prioritized.
  if (!t.hasSavedAccount) score -= 25;
  return score;
}

/**
 * Recommend the action for one non-canonical record. Pure decision tree:
 *   - Anchor tenant                                  → flag_anchor_tenant
 *   - Zombie + no traffic + no phones                → deactivate_zombie (safe)
 *   - Zombie WITH traffic OR phones                  → manual_review (NOT safe)
 *   - Real backing but not canonical (true duplicate)→ soft_disable_duplicate
 *   - Otherwise (unexpected)                         → manual_review
 *
 * The caller decides whether canonical exists; if no canonical, every record
 * in the group gets its own recommendation (typically deactivate_zombie or
 * flag_anchor_tenant).
 */
export function recommendTenantAction(
  t: AuditTenantRow,
  canonical: AuditTenantRow | null,
): { action: RecommendedAction; safeToDelete: boolean; reason: string } {
  if (isPlatformAnchor(t)) {
    return {
      action: 'flag_anchor_tenant',
      safeToDelete: false,
      reason: 'platform anchor tenant — must never be selected as customer workspace',
    };
  }

  if (canonical && canonical.id === t.id) {
    return {
      action: 'keep_canonical',
      safeToDelete: false,
      reason: 'canonical record',
    };
  }

  const zombie = isZombieTenant(t);
  const hasTraffic = t.conversationCount > 0;
  const hasPhones = t.phoneNumberCount > 0;
  const hasOtherWiring =
    t.apiKeyCount > 0 ||
    t.endpointRouteCount > 0 ||
    t.webhookSubscriptionCount > 0;

  if (zombie && !hasTraffic && !hasPhones && !hasOtherWiring) {
    return {
      action: 'deactivate_zombie',
      safeToDelete: true,
      reason: 'no SavedAccount backing, no traffic, no phones, no wiring',
    };
  }

  if (zombie && (hasTraffic || hasPhones || hasOtherWiring)) {
    return {
      action: 'manual_review',
      safeToDelete: false,
      reason: `zombie tenant retains live wiring — convs=${t.conversationCount} phones=${t.phoneNumberCount} keys=${t.apiKeyCount} routes=${t.endpointRouteCount} subs=${t.webhookSubscriptionCount}`,
    };
  }

  if (canonical) {
    // Real duplicate — has SavedAccount, but a sibling has stronger signals.
    return {
      action: 'soft_disable_duplicate',
      safeToDelete: hasTraffic ? false : true,
      reason: `duplicate of canonical ${canonical.id}; ${
        hasTraffic ? 'has historical traffic — repoint before delete' : 'no traffic'
      }`,
    };
  }

  return {
    action: 'manual_review',
    safeToDelete: false,
    reason: 'no canonical chosen; group has no clear winner',
  };
}

// ---------------------------------------------------------------------------
// Tenant grouping
// ---------------------------------------------------------------------------

/**
 * Group tenants for duplicate detection. The signature is one of:
 *   - 'lb-user:<lb_user_id>'    when the tenant has at least one business
 *     with metadata.lb_user_id set (PR6 marker).
 *   - 'name:<normalized-name>'  when the tenant has no lb_user_id but a real
 *     non-stub name. Catches zombie clones of real tenants (e.g. multiple
 *     "Spotless Homes Tampa" tenants where only one has SavedAccount backing).
 *   - 'anchor:<platform>'       for bootstrap anchor tenants.
 *   - 'orphan:<tenant_id>'      for tenants with no signal — singleton groups.
 *
 * Returns groups with size >= 1; the caller filters to size > 1 if desired.
 */
export function groupTenantsForDuplicates(
  tenants: AuditTenantRow[],
  lbUserIdByTenantId: Map<string, string>,
): Map<string, AuditTenantRow[]> {
  const groups = new Map<string, AuditTenantRow[]>();
  for (const t of tenants) {
    const sig = tenantSignature(t, lbUserIdByTenantId);
    const arr = groups.get(sig) ?? [];
    arr.push(t);
    groups.set(sig, arr);
  }
  return groups;
}

export function tenantSignature(
  t: AuditTenantRow,
  lbUserIdByTenantId: Map<string, string>,
): string {
  if (isPlatformAnchor(t)) {
    return `anchor:${normalizeName(t.name) || t.externalId || t.id}`;
  }
  const lbUserId = lbUserIdByTenantId.get(t.id);
  if (lbUserId) return `lb-user:${lbUserId}`;
  // No lb_user_id (zombie or non-LB). Group by name when name is a real
  // brand; otherwise treat as singleton.
  if (t.name && !isAccountStubName(t.name)) {
    return `name:${normalizeName(t.name)}`;
  }
  return `orphan:${t.id}`;
}

// ---------------------------------------------------------------------------
// Business grouping (within a workspace)
// ---------------------------------------------------------------------------

/**
 * Compute a normalized location signature for a business. Prefers
 * metadata.location (curated/suffix-strip from PR6); falls back to
 * normalized display_name when missing.
 */
export function businessLocationSignature(b: AuditBusinessRow): string {
  const meta = b.metadata ?? {};
  const loc = typeof meta.location === 'string' ? meta.location.trim() : '';
  if (loc) return `loc:${loc.toLowerCase()}`;
  return `name:${normalizeName(b.displayName)}`;
}

/**
 * Group businesses by (workspaceKey, location). Workspace key follows the
 * same convention as PR8 (`lb-user-<id>` or `tenant-<id>`).
 */
export function groupBusinessesForDuplicates(
  businesses: AuditBusinessRow[],
  workspaceKeyByBusinessId: Map<string, string>,
): Map<string, AuditBusinessRow[]> {
  const groups = new Map<string, AuditBusinessRow[]>();
  for (const b of businesses) {
    const wk = workspaceKeyByBusinessId.get(b.id) ?? `tenant-${b.tenantId}`;
    const sig = `${wk}::${businessLocationSignature(b)}`;
    const arr = groups.get(sig) ?? [];
    arr.push(b);
    groups.set(sig, arr);
  }
  return groups;
}

export function selectCanonicalBusiness(
  candidates: AuditBusinessRow[],
): string | null {
  if (candidates.length === 0) return null;
  // Strong signal: has external_business_id (PR6 set this for LB businesses
  // that were materialized from a real SavedAccount).
  const scored = candidates.map((b) => ({
    b,
    score:
      (b.externalBusinessId ? 100 : 0) +
      (b.activePhoneAssignments > 0 ? 30 : 0) +
      (b.profileCount > 0 ? 20 : 0) +
      (b.status === 'active' ? 5 : 0),
  }));
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.b.id.localeCompare(b.b.id);
  });
  return scored[0].b.id;
}

// ---------------------------------------------------------------------------
// Profile grouping (within a business)
// ---------------------------------------------------------------------------

/**
 * Profiles are already protected by a partial-unique index on
 * (business_id, source, external_profile_id) WHERE external_profile_id IS NOT NULL.
 * That means duplicate profiles can only exist when external_profile_id IS NULL
 * — typically multiple kept Default profiles (slug='default', PR6 left those
 * around for back-compat). Group on (business_id, source, slug, external_profile_id)
 * and report any group with size > 1 for review.
 */
export function groupProfilesForDuplicates(
  profiles: AuditProfileRow[],
): Map<string, AuditProfileRow[]> {
  const groups = new Map<string, AuditProfileRow[]>();
  for (const p of profiles) {
    const ext = p.externalProfileId ?? '<null>';
    const sig = `${p.communicationBusinessId}::${p.source}::${ext}`;
    const arr = groups.get(sig) ?? [];
    arr.push(p);
    groups.set(sig, arr);
  }
  return groups;
}

export function selectCanonicalProfile(
  candidates: AuditProfileRow[],
): string | null {
  if (candidates.length === 0) return null;
  const scored = candidates.map((p) => ({
    p,
    score:
      (p.isDefault ? 50 : 0) +
      (p.externalProfileId ? 100 : 0) +
      (p.activePhoneAssignments > 0 ? 30 : 0) +
      (p.status === 'active' ? 5 : 0),
  }));
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.p.id.localeCompare(b.p.id);
  });
  return scored[0].p.id;
}
