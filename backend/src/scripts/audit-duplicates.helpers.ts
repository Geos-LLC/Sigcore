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
 * canonical id, or null if the group contains no SavedAccount-backed
 * candidate (PR9.1 — locked rule: zombie-only groups must surface as
 * manual_review, never auto-merge into another zombie).
 *
 * Strict rules:
 *   - candidate must have hasSavedAccount=true (real LB tenant)
 *   - never an anchor (defensive — should have been filtered upstream)
 *   - among real candidates: highest score wins (active phones, recent
 *     traffic, wired up)
 *   - ties broken by tenant.id ascending (deterministic)
 */
export function selectCanonicalTenant(
  candidates: AuditTenantRow[],
): string | null {
  const realCandidates = candidates.filter(
    (t) => !isPlatformAnchor(t) && t.hasSavedAccount,
  );
  if (realCandidates.length === 0) return null;

  const scored = realCandidates.map((t) => ({
    t,
    score: scoreTenantForCanonical(t),
  }));
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.t.id.localeCompare(b.t.id);
  });
  return scored[0].t.id;
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
 * Recommend the action for one record. PR9.1 rule changes:
 *   - Anchor tenant                            → flag_anchor_tenant
 *   - Multi-record group with NO canonical     → manual_review (locked rule:
 *                                                zombie-only groups must
 *                                                NEVER auto-pick a zombie
 *                                                as canonical)
 *   - Singleton clean zombie (no group sibling)→ deactivate_zombie (safe)
 *   - Singleton zombie with live wiring        → manual_review
 *   - Real backing, not canonical              → soft_disable_duplicate
 *
 * `groupSize` lets the caller signal whether the tenant sits in a multi-
 * record group (where canonical=null means manual_review) or alone (where
 * a clean zombie is still safe to deactivate independently).
 */
export function recommendTenantAction(
  t: AuditTenantRow,
  canonical: AuditTenantRow | null,
  groupSize = 1,
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

  // No canonical AND multi-record group: rule #4 — never auto-merge zombies
  // into another zombie. Surface the whole group for manual review.
  if (!canonical && groupSize > 1) {
    return {
      action: 'manual_review',
      safeToDelete: false,
      reason:
        'multi-record group with no SavedAccount-backed canonical; manual mapping required',
    };
  }

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
 * PR9.1 strict signature: tenants are duplicates iff they collide on
 *
 *   platform + customer + location + source
 *
 * - platform     attribution result ('leadbridge', 'hirefunnel', …)
 * - customer     lb_user_id when set (PR6 metadata), otherwise tenant.external_id
 *                (zombies have unique external_ids → they don't cluster with
 *                each other under the customer dimension)
 * - location     metadata.location (curated/suffix-strip from PR6) when set,
 *                otherwise normalizeName(business.display_name)
 * - source       most authoritative profile source under the tenant —
 *                a real materialized source ('thumbtack' / 'yelp') is
 *                preferred over the kept Default profile's 'leadbridge'
 *
 * Effect on real prod data:
 *   - Spotless Homes Tampa TT  ≠  Spotless Homes Jacksonville TT (different location)
 *   - Spotless Homes Tampa TT  ≠  Spotless Homes Tampa Yelp     (different source)
 *   - Lavanda TT              ≠  Lavanda Yelp                   (different source)
 *   - Each zombie is alone (its own tenant.external_id as customer key)
 *     → singleton groups → no spurious zombie-zombie auto-merge
 *
 * Anchors get their own degenerate signature so they can never collide with
 * a customer tenant.
 */
export interface TenantSignatureInputs {
  /** Platform attribution result, e.g. 'leadbridge'. */
  platformId: string;
  /** lb_user_id when known. */
  lbUserId: string | null;
  /** From metadata.location when present, else null. */
  curatedLocation: string | null;
  /** Highest-quality businesses display_name available for fallback. */
  fallbackLocationName: string | null;
  /** Best non-default profile source under this tenant; null when only Default exists. */
  bestRealSource: string | null;
  /** Default profile source — used when bestRealSource is null. */
  defaultSource: string | null;
}

const ANCHOR_SIGNATURE_PREFIX = 'anchor:';

export function tenantSignature(
  t: AuditTenantRow,
  inputs: TenantSignatureInputs,
): string {
  if (isPlatformAnchor(t)) {
    return `${ANCHOR_SIGNATURE_PREFIX}${normalizeName(t.name) || t.externalId || t.id}`;
  }
  const platformKey = inputs.platformId || 'unclassified';
  const customerKey = inputs.lbUserId
    ? `lb-user:${inputs.lbUserId}`
    : `ext:${t.externalId ?? t.id}`;
  const locationKey = inputs.curatedLocation
    ? `loc:${inputs.curatedLocation}`
    : inputs.fallbackLocationName
      ? `name:${normalizeName(inputs.fallbackLocationName)}`
      : 'noloc';
  const sourceKey = inputs.bestRealSource
    ? `src:${inputs.bestRealSource}`
    : inputs.defaultSource
      ? `src:${inputs.defaultSource}`
      : 'src:unknown';
  return `${platformKey}|${customerKey}|${locationKey}|${sourceKey}`;
}

/**
 * Group tenants for duplicate detection using the strict 4-dimension
 * signature. Caller computes per-tenant signatures (the script does this
 * by joining tenants → businesses → profiles).
 *
 * Returns groups with size >= 1; the caller filters to size > 1 if desired.
 */
export function groupTenantsBySignature(
  tenants: AuditTenantRow[],
  signatureByTenantId: Map<string, string>,
): Map<string, AuditTenantRow[]> {
  const groups = new Map<string, AuditTenantRow[]>();
  for (const t of tenants) {
    const sig = signatureByTenantId.get(t.id);
    if (!sig) continue;
    const arr = groups.get(sig) ?? [];
    arr.push(t);
    groups.set(sig, arr);
  }
  return groups;
}

/**
 * Pick the best location key for a tenant by walking its businesses:
 *   - prefer any business whose metadata.location is set (PR6 curated)
 *   - otherwise fall back to the first non-empty businesses display_name
 */
export function pickBestLocationFromBusinesses(
  businesses: AuditBusinessRow[],
): { curated: string | null; fallback: string | null } {
  let curated: string | null = null;
  let fallback: string | null = null;
  for (const b of businesses) {
    const loc = (b.metadata?.location as string | undefined)?.trim();
    if (loc && !curated) curated = loc.toLowerCase();
    if (!fallback && b.displayName) fallback = b.displayName.trim() || null;
  }
  return { curated, fallback };
}

/**
 * Pick the best source key for a tenant from its profiles.
 *   - prefer any profile whose source is NOT the legacy default
 *     ('leadbridge', 'hirefunnel', 'serviceflow', 'callio', 'internal')
 *   - among preferred candidates, choose deterministically (alpha)
 *   - fall back to the default-profile source when no real source exists
 */
const LEGACY_DEFAULT_SOURCES = new Set([
  'leadbridge',
  'hirefunnel',
  'serviceflow',
  'callio',
  'internal',
]);

export function pickBestSourceFromProfiles(
  profiles: AuditProfileRow[],
): { real: string | null; defaulted: string | null } {
  const realSources = Array.from(
    new Set(
      profiles
        .filter((p) => p.source && !LEGACY_DEFAULT_SOURCES.has(p.source))
        .map((p) => p.source),
    ),
  ).sort();
  const defaultSources = Array.from(
    new Set(profiles.filter((p) => p.isDefault).map((p) => p.source)),
  ).sort();
  return {
    real: realSources.length > 0 ? realSources[0] : null,
    defaulted: defaultSources.length > 0 ? defaultSources[0] : null,
  };
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
