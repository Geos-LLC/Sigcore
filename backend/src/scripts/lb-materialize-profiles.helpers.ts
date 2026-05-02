/**
 * Pure helpers for the LeadBridge profile-materialization script.
 *
 * Kept I/O-free so they can be unit-tested without a database, and so the
 * script's plan-building logic stays deterministic regardless of the order
 * rows arrive in.
 *
 * The script itself (lb-materialize-profiles.ts) handles the DataSource,
 * argv parsing, validation passes, and transaction orchestration. This file
 * owns:
 *   - location parsing (curated map → suffix-strip → brand fallback)
 *   - profile slug + display-name composition
 *   - per-tenant plan construction
 *
 * Lexicon used here matches the entities:
 *   - SavedAccount  (LeadBridge)            : id, userId, platform, businessId, businessName
 *   - Tenant        (Sigcore)               : id, externalId
 *   - CommunicationBusiness                  : id, displayName, metadata
 *   - CommunicationProfile                   : id, source, externalProfileId, isDefault, slug
 *   - ProfilePhoneAssignment                 : id, profileId, active
 */

export type LbPlatform = 'thumbtack' | 'yelp';

export interface LbSavedAccount {
  id: string;
  userId: string;
  platform: string;
  businessId: string;
  businessName: string;
  /** Optional: the LB User.name; used as the brand string for suffix-strip + fallback. */
  userName?: string | null;
  /** Optional: LB Organization.id, when the SavedAccount belongs to a team. */
  organizationId?: string | null;
}

export interface LocationMapEntry {
  locationKey: string;
  locationDisplay: string;
}

export type LocationMap = Record<string, LocationMapEntry>;

export interface ParsedLocation {
  /** kebab-case key, e.g. "tampa", "saint-petersburg". Used in slug. */
  key: string;
  /** Title-case display, e.g. "Tampa", "Saint Petersburg". Used in display_name. */
  display: string;
  /** Where the value came from — useful for the dry-run report. */
  source: 'curated' | 'suffix_strip' | 'brand_fallback';
}

/**
 * Resolve the location for a SavedAccount.
 *
 * Priority:
 *   1. Curated map (operator-reviewed CSV/JSON keyed by savedAccountId).
 *   2. Suffix-strip: businessName − userName (when the businessName starts
 *      with the brand, e.g. "Spotless Homes Tampa" minus "Spotless Homes").
 *   3. Brand fallback: use the businessName itself (single-location case
 *      like "Lavanda Cleaning") — short brand without a city suffix.
 *
 * Pure — no I/O. The empty/whitespace edge cases all collapse to the brand
 * fallback to keep the slug well-formed.
 */
export function parseLocation(
  saved: LbSavedAccount,
  locationMap: LocationMap | null | undefined,
): ParsedLocation {
  // 1. Curated map
  const curated = locationMap?.[saved.id];
  if (curated && curated.locationKey && curated.locationDisplay) {
    return {
      key: slugifyLocation(curated.locationKey),
      display: curated.locationDisplay.trim(),
      source: 'curated',
    };
  }

  const businessName = (saved.businessName || '').trim();
  const userName = (saved.userName || '').trim();

  // 2. Suffix-strip: businessName − userName, case-insensitive prefix match.
  if (
    businessName.length > 0 &&
    userName.length > 0 &&
    businessName.toLowerCase().startsWith(userName.toLowerCase()) &&
    businessName.length > userName.length
  ) {
    const tail = businessName
      .slice(userName.length)
      .replace(/^[\s\-:_,]+/, '')
      .trim();
    if (tail.length > 0) {
      return {
        key: slugifyLocation(tail),
        display: tail,
        source: 'suffix_strip',
      };
    }
  }

  // 3. Brand fallback (single-location case).
  const brand = pickBrand(businessName, userName);
  return {
    key: slugifyLocation(brand),
    display: brand,
    source: 'brand_fallback',
  };
}

/**
 * Lowercase, kebab-case, ASCII-only. Empty input → "unknown".
 *
 *   "Saint Petersburg"  → "saint-petersburg"
 *   "St. Pete, FL"      → "st-pete-fl"
 *   ""                  → "unknown"
 */
export function slugifyLocation(s: string | null | undefined): string {
  const cleaned = (s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || 'unknown';
}

/**
 * Pick a sensible brand string. Prefer the business name (more specific
 * than user.name when they differ), but fall back to user.name or a
 * placeholder so the result is always non-empty.
 */
function pickBrand(businessName: string, userName: string): string {
  if (businessName) return businessName;
  if (userName) return userName;
  return 'Unknown';
}

/**
 * Validate that a string is one of the platforms we materialize.
 * Anything else (e.g. "facebook", "manual") falls outside this script's
 * scope — the script will skip the tenant and report it.
 */
export function normalizePlatform(p: string | null | undefined): LbPlatform | null {
  const v = (p ?? '').trim().toLowerCase();
  if (v === 'thumbtack') return 'thumbtack';
  if (v === 'yelp') return 'yelp';
  return null;
}

/**
 * Title-case the platform for display: "thumbtack" → "Thumbtack".
 */
export function platformDisplay(p: LbPlatform): string {
  return p.charAt(0).toUpperCase() + p.slice(1);
}

// ---------------------------------------------------------------------------
// Plan construction
// ---------------------------------------------------------------------------

export interface TenantInput {
  tenantId: string;
  workspaceId: string;
  tenantExternalId: string | null;
  tenantName: string | null;

  /** The single existing communication_businesses row backfilled by 1764000100000. */
  businessId: string;
  businessDisplayName: string;
  businessMetadata: Record<string, unknown> | null;

  /** The single is_default=TRUE communication_profiles row under that business. */
  defaultProfileId: string;
  defaultProfileSource: string;
  defaultProfileSlug: string;
  defaultProfileExternalId: string | null;

  /** ACTIVE phone assignments under the default profile (the only ones we move). */
  activePhoneAssignmentIds: string[];

  /** The matching LB SavedAccount (resolved by tenantExternalId === SavedAccount.id). */
  savedAccount: LbSavedAccount;
}

export type SkipReason =
  | 'tenant_external_id_mismatch'
  | 'no_default_profile'
  | 'unsupported_platform'
  | 'missing_business_id'
  | 'already_materialized';

export type TenantPlan =
  | { kind: 'skip'; tenantId: string; reason: SkipReason; detail?: string }
  | {
      kind: 'apply';
      tenantId: string;
      workspaceId: string;
      businessId: string;
      defaultProfileId: string;
      newProfile: {
        platform: LbPlatform;
        externalProfileId: string;
        displayName: string;
        slug: string;
        savedAccountId: string;
      };
      businessUpdate: {
        newDisplayName: string;
        newMetadata: Record<string, unknown>;
      };
      phoneAssignmentIdsToMove: string[];
      location: ParsedLocation;
    };

/**
 * Build the plan for one tenant. Returns either a skip (with reason) or an
 * apply (with all field values the SQL will need). Never throws — bad inputs
 * become structured skips so the dry-run report can list them.
 */
export function planForTenant(
  input: TenantInput,
  locationMap: LocationMap | null | undefined,
): TenantPlan {
  const { tenantId, savedAccount } = input;

  // The validation pass should have caught this, but defend anyway —
  // mismatched tenant.external_id → SavedAccount.id is unsafe to write.
  if (input.tenantExternalId !== savedAccount.id) {
    return {
      kind: 'skip',
      tenantId,
      reason: 'tenant_external_id_mismatch',
      detail: `tenant.external_id=${input.tenantExternalId} vs SavedAccount.id=${savedAccount.id}`,
    };
  }

  if (!input.defaultProfileId) {
    return { kind: 'skip', tenantId, reason: 'no_default_profile' };
  }

  if (!input.businessId) {
    return { kind: 'skip', tenantId, reason: 'missing_business_id' };
  }

  const platform = normalizePlatform(savedAccount.platform);
  if (!platform) {
    return {
      kind: 'skip',
      tenantId,
      reason: 'unsupported_platform',
      detail: `platform="${savedAccount.platform}"`,
    };
  }

  const platformBusinessId = (savedAccount.businessId || '').trim();
  if (!platformBusinessId) {
    return {
      kind: 'skip',
      tenantId,
      reason: 'unsupported_platform',
      detail: 'SavedAccount.businessId is empty',
    };
  }

  // Idempotency hint: if the existing default profile already matches what
  // we'd insert (source + external_profile_id), the script's executor will
  // detect this via SELECT and convert to a no-op. We still emit an apply
  // plan here so the executor reports a consistent shape.
  const location = parseLocation(savedAccount, locationMap);

  const newDisplayName = `${platformDisplay(platform)} ${location.display}`;
  const newSlug = `${platform}-${location.key}`;

  const businessDisplayName = (savedAccount.businessName || '').trim() ||
    input.businessDisplayName;

  const mergedMetadata: Record<string, unknown> = {
    ...(input.businessMetadata ?? {}),
    location: location.key,
    location_display: location.display,
    location_source: location.source,
    lb_user_id: savedAccount.userId,
    lb_organization_id: savedAccount.organizationId ?? null,
    lb_saved_account_id: savedAccount.id,
  };

  return {
    kind: 'apply',
    tenantId,
    workspaceId: input.workspaceId,
    businessId: input.businessId,
    defaultProfileId: input.defaultProfileId,
    newProfile: {
      platform,
      externalProfileId: platformBusinessId,
      displayName: newDisplayName,
      slug: newSlug,
      savedAccountId: savedAccount.id,
    },
    businessUpdate: {
      newDisplayName: businessDisplayName,
      newMetadata: mergedMetadata,
    },
    phoneAssignmentIdsToMove: [...input.activePhoneAssignmentIds],
    location,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  tenantId: string;
  tenantExternalId: string | null;
  reason:
    | 'no_saved_account_for_external_id'
    | 'saved_account_id_mismatch'
    | 'unsupported_platform_in_saved_account';
  detail: string;
}

/**
 * Decide whether the live execution is allowed to proceed given a
 * validation result and operator flags.
 *
 * Locked rules:
 *   - validation.ok === true                          → proceed
 *   - dry-run                                         → proceed (script only previews)
 *   - --allow-orphan-tenants AND only orphan issues   → proceed (orphans demoted to skips)
 *   - any non-orphan validation issue                 → abort
 *   - has orphan issues, no --allow-orphan-tenants    → abort
 *
 * Pure — no I/O. Used by the executable script's gate; unit-tested
 * separately so the script's branching logic stays trivial.
 */
export interface ValidationGateInput {
  validation: { ok: boolean; issues: ValidationIssue[] };
  dryRun: boolean;
  allowOrphanTenants: boolean;
}

export interface ValidationGateDecision {
  decision: 'proceed' | 'abort';
  reason:
    | 'no_issues'
    | 'dry_run_preview'
    | 'orphans_allowed'
    | 'orphans_not_allowed'
    | 'hard_issues_present';
  orphans: ValidationIssue[];
  hardIssues: ValidationIssue[];
}

export function evaluateValidationGate(
  input: ValidationGateInput,
): ValidationGateDecision {
  const orphans = input.validation.issues.filter(
    (i) => i.reason === 'no_saved_account_for_external_id',
  );
  const hardIssues = input.validation.issues.filter(
    (i) => i.reason !== 'no_saved_account_for_external_id',
  );

  if (input.validation.ok) {
    return { decision: 'proceed', reason: 'no_issues', orphans, hardIssues };
  }

  if (input.dryRun) {
    return { decision: 'proceed', reason: 'dry_run_preview', orphans, hardIssues };
  }

  if (hardIssues.length > 0) {
    return {
      decision: 'abort',
      reason: 'hard_issues_present',
      orphans,
      hardIssues,
    };
  }

  if (input.allowOrphanTenants) {
    return {
      decision: 'proceed',
      reason: 'orphans_allowed',
      orphans,
      hardIssues,
    };
  }

  return {
    decision: 'abort',
    reason: 'orphans_not_allowed',
    orphans,
    hardIssues,
  };
}

/**
 * Pre-write validation: every leadbridge tenant must have a corresponding
 * LB SavedAccount whose id exactly equals tenant.external_id, and the
 * SavedAccount.platform must be one we know how to materialize.
 *
 * Returns (issues, ok) — `issues.length === 0` means safe to proceed.
 */
export function validateTenantSavedAccountAlignment(
  tenants: Array<{ tenantId: string; tenantExternalId: string | null }>,
  savedAccountsById: Map<string, LbSavedAccount>,
): { issues: ValidationIssue[]; ok: boolean } {
  const issues: ValidationIssue[] = [];

  for (const t of tenants) {
    const ext = t.tenantExternalId;
    if (!ext) {
      issues.push({
        tenantId: t.tenantId,
        tenantExternalId: ext,
        reason: 'no_saved_account_for_external_id',
        detail: 'tenant.external_id is null',
      });
      continue;
    }

    const sa = savedAccountsById.get(ext);
    if (!sa) {
      issues.push({
        tenantId: t.tenantId,
        tenantExternalId: ext,
        reason: 'no_saved_account_for_external_id',
        detail: `no LB SavedAccount with id=${ext}`,
      });
      continue;
    }

    if (sa.id !== ext) {
      issues.push({
        tenantId: t.tenantId,
        tenantExternalId: ext,
        reason: 'saved_account_id_mismatch',
        detail: `SavedAccount.id=${sa.id} for lookup=${ext}`,
      });
      continue;
    }

    if (!normalizePlatform(sa.platform)) {
      issues.push({
        tenantId: t.tenantId,
        tenantExternalId: ext,
        reason: 'unsupported_platform_in_saved_account',
        detail: `platform="${sa.platform}"`,
      });
    }
  }

  return { issues, ok: issues.length === 0 };
}
