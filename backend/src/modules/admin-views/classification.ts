/**
 * Admin UI classification helpers (PR14).
 *
 * Single source of truth for "is this a real customer record / a zombie /
 * a platform anchor?" — encoded once, applied across Workspaces, Businesses,
 * Profiles, and Platform-count views.
 *
 * Rules mirror PR9.1's audit signature exactly so the UI and the audit
 * agree on what's real:
 *
 *   workspace
 *     real_customer  — kind='lb_customer' (PR6 metadata.lb_user_id)
 *                      OR kind='tenant' AND platformId is a known non-LB platform
 *     zombie         — kind='tenant' AND (platformId='leadbridge' OR 'unclassified')
 *                      with no PR6-materialized real source signal
 *     anchor         — name matches LeadBridge / HireFunnel / ServiceFlow / Callio
 *
 *   business
 *     real           — has metadata.lb_user_id (set by PR6) OR external_business_id
 *     zombie         — neither
 *
 *   profile
 *     real_source    — non-default source (thumbtack / yelp / facebook / craigslist / indeed)
 *                      OR a default profile under a real business
 *     kept_default   — slug='default' AND is_default=false (PR6 demoted, kept for back-compat)
 *     zombie_default — slug='default' AND parent business is zombie
 *
 * Pure — no I/O, no DB.
 */

// ---------------------------------------------------------------------------
// Anchor detection (frozen — same set as audit + provisioning paths)
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

/** True when the tenant.name or external_id matches a platform anchor. */
export function isAnchorByNameOrExternalId(input: {
  name?: string | null;
  externalId?: string | null;
}): boolean {
  const norm = (input.name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (ANCHOR_NAME_NORMALIZED.has(norm)) return true;
  if (input.externalId && ANCHOR_EXTERNAL_PATTERN.test(input.externalId)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Workspace classification
// ---------------------------------------------------------------------------

export type WorkspaceClassification = 'real_customer' | 'zombie' | 'anchor';

export interface ClassifyWorkspaceInput {
  /** WorkspaceSummary.kind: 'lb_customer' | 'tenant'. */
  kind: 'lb_customer' | 'tenant';
  /** WorkspaceSummary.platformId. */
  platformId: string;
  /** WorkspaceSummary.displayName — used for anchor name detection on solo-tenant rows. */
  displayName: string;
  /** Solo-tenant workspaces have one tenant id; pass it for anchor external_id check. */
  tenantExternalId?: string | null;
}

export function classifyWorkspace(
  input: ClassifyWorkspaceInput,
): WorkspaceClassification {
  if (
    isAnchorByNameOrExternalId({
      name: input.displayName,
      externalId: input.tenantExternalId ?? null,
    })
  ) {
    return 'anchor';
  }
  if (input.kind === 'lb_customer') return 'real_customer';
  // kind === 'tenant'
  // Non-LB platforms (HireFunnel, ServiceFlow, Callio) are real direct customers.
  if (
    input.platformId === 'hirefunnel' ||
    input.platformId === 'serviceflow' ||
    input.platformId === 'callio'
  ) {
    return 'real_customer';
  }
  // LB tenants without lb_user_id → zombie. Unclassified → zombie.
  return 'zombie';
}

// ---------------------------------------------------------------------------
// Business classification
// ---------------------------------------------------------------------------

export type BusinessClassification = 'real' | 'zombie';

export interface ClassifyBusinessInput {
  /** lb_user_id parsed out of metadata at the service layer. */
  lbUserId: string | null;
  externalBusinessId: string | null;
  /** Inherited platform attribution from the parent tenant. */
  platformId: string;
}

export function classifyBusiness(
  input: ClassifyBusinessInput,
): BusinessClassification {
  if (input.lbUserId) return 'real';
  if (input.externalBusinessId) return 'real';
  // Non-LB platform tenants don't get PR6 metadata but their single business
  // row is still real (they're the customer's only business).
  if (
    input.platformId === 'hirefunnel' ||
    input.platformId === 'serviceflow' ||
    input.platformId === 'callio'
  ) {
    return 'real';
  }
  return 'zombie';
}

// ---------------------------------------------------------------------------
// Profile classification
// ---------------------------------------------------------------------------

export type ProfileClassification =
  | 'real_source'
  | 'kept_default'
  | 'zombie_default';

const REAL_SOURCE_SET = new Set([
  'thumbtack',
  'yelp',
  'facebook',
  'craigslist',
  'indeed',
  'manual',
]);

export interface ClassifyProfileInput {
  source: string;
  slug: string;
  isDefault: boolean;
  /** Classification of the parent business (caller passes it in). */
  parentBusinessClassification: BusinessClassification;
}

export function classifyProfile(
  input: ClassifyProfileInput,
): ProfileClassification {
  if (REAL_SOURCE_SET.has(input.source)) return 'real_source';
  // Default profiles under a zombie business → zombie default
  if (input.slug === 'default' && input.parentBusinessClassification === 'zombie') {
    return 'zombie_default';
  }
  // PR6 demoted defaults: slug='default' AND is_default=false → kept_default
  if (input.slug === 'default' && !input.isDefault) {
    return 'kept_default';
  }
  // Active default under a real business — surface as real (the default is the
  // primary routing target until the operator materializes a real source).
  return 'real_source';
}

// ---------------------------------------------------------------------------
// Filter input + helpers
// ---------------------------------------------------------------------------

export interface VisibilityFilters {
  /** When true, include zombies in the response. Default false. */
  includeZombies?: boolean;
  /** When true, include anchor tenants in the response. Default false. */
  includeAnchors?: boolean;
  /** When true, include kept_default + zombie_default profiles. Default false. */
  showRawDefaults?: boolean;
}

export interface ListMeta {
  total: number;
  visible: number;
  hiddenZombies: number;
  hiddenAnchors: number;
  hiddenRawDefaults?: number;
}

/**
 * Decide whether a workspace passes the visibility gate. Pure.
 */
export function workspaceIsVisible(
  classification: WorkspaceClassification,
  filters: VisibilityFilters,
): boolean {
  if (classification === 'real_customer') return true;
  if (classification === 'zombie') return filters.includeZombies === true;
  if (classification === 'anchor') return filters.includeAnchors === true;
  return false;
}

export function businessIsVisible(
  classification: BusinessClassification,
  filters: VisibilityFilters,
): boolean {
  if (classification === 'real') return true;
  return filters.includeZombies === true;
}

export function profileIsVisible(
  classification: ProfileClassification,
  filters: VisibilityFilters,
): boolean {
  if (classification === 'real_source') return true;
  if (classification === 'kept_default') return filters.showRawDefaults === true;
  if (classification === 'zombie_default') {
    // zombie defaults need both flags — they live under zombie businesses
    // AND they are auto-defaults. Either flag alone reveals them.
    return filters.showRawDefaults === true || filters.includeZombies === true;
  }
  return false;
}
