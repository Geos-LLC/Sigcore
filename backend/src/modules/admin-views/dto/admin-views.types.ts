/**
 * Shared response shapes for the admin-views module.
 * Mirror these on the frontend (frontend/src/types/) so the wire format stays in sync.
 */

export type PlatformId =
  | 'leadbridge'
  | 'hirefunnel'
  | 'serviceflow'
  | 'callio'
  | 'unclassified';

export interface PlatformSummary {
  id: PlatformId;
  name: string;
  anchorTenantId: string | null;
  workspaceCount: number;
  apiKeyCount: number;
  phoneNumberCount: number;
  webhookSubscriptionCount: number;
  lastActivityAt: string | null;
}

export interface PlatformWorkspaceRow {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  /**
   * Why this tenant was attributed to this platform. Lexicon:
   *   'anchor_name'                       — tenants.name == platform anchor
   *   'product_workspace:<type>'          — product_workspaces.product_type
   *   'webhook_url:<host-token>'          — webhook URL hostname pattern
   *   'api_key_name:<token>'              — api_keys.name pattern
   *   'unclassified'                      — no signal matched
   */
  attributionReason: string;
}

export interface PlatformPhoneRow {
  id: string;
  phoneNumber: string;
  provider: string;
  a2pStatus: string | null;
  tenantId: string;
  tenantName: string | null;
}

export interface PlatformApiKeyRow {
  id: string;
  name: string;
  scope: 'workspace' | 'tenant';
  tenantId: string | null;
  tenantName: string | null;
  lastUsedAt: string | null;
  active: boolean;
}

export interface PlatformWebhookRow {
  id: string;
  name: string;
  webhookUrl: string;
  events: string[];
  status: string;
  tenantId: string | null;
  tenantName: string | null;
}

/**
 * Profile under a customer workspace. With real profiles (PR2+) each row
 * corresponds to a real `communication_profiles` record. With the legacy
 * derived path (fallback only) multiple tenants with the same profile name
 * collapse into one row with `duplicateCount > 1`.
 */
export interface ProfileRow {
  name: string;
  duplicateCount: number;
  tenantIds: string[];
  phoneNumbersCount: number;
  hasLegacy: boolean;
  hasCurrent: boolean;
  attributionReasons: string[];
  // Real-profile-backed fields (null on legacy derived rows).
  communicationProfileId?: string | null;
  source?: string | null;
  externalProfileId?: string | null;
  slug?: string | null;
}

/** Source rule that produced this workspace group. */
export type WorkspaceGroupSource =
  | 'business_identity'
  | 'name_prefix'
  | 'standalone';

/**
 * Customer workspace. With real profiles (PR2+), each WorkspaceGroup is one
 * `communication_businesses` row. With the legacy derived path (fallback)
 * tenants are grouped by business_identity_id / name prefix / standalone.
 */
export interface WorkspaceGroup {
  name: string;
  source: WorkspaceGroupSource;
  businessIdentityId: string | null;
  profiles: ProfileRow[];
  profileCount: number;
  totalTenantCount: number;
  totalPhoneNumbersCount: number;
  attributionReasons: string[];
  // Real-business-backed fields (null on legacy derived groups).
  communicationBusinessId?: string | null;
  externalBusinessId?: string | null;
  tenantId?: string | null;
  tenantName?: string | null;
}

export interface PlatformDetail extends PlatformSummary {
  workspaces: PlatformWorkspaceRow[];
  /**
   * Customer workspaces inferred from tenant signals — see workspace-grouping.ts.
   * Additive on the wire: the flat `workspaces` array above is unchanged so any
   * existing consumers keep working.
   */
  workspaceGroups: WorkspaceGroup[];
  phoneNumbers: PlatformPhoneRow[];
  apiKeys: PlatformApiKeyRow[];
  webhooks: PlatformWebhookRow[];
}

export type PhoneModelBadge = 'CURRENT' | 'LEGACY' | 'BOTH';

export interface InventoryCurrentBlock {
  id: string;
  tenantId: string;
  tenantName: string | null;
  workspaceId: string;
  status: string;
}

export interface InventoryLegacyBlock {
  id: string;
  businessId: string;
  businessIdResolution: 'workspace' | 'tenant' | 'unknown';
  type: 'BOT' | 'DEDICATED';
  active: boolean;
}

/**
 * The full assignment chain for a phone number (PR8): Platform → Workspace
 * → Business → Profile. All fields are nullable so legacy/orphan rows still
 * render. When `chain.length > 1` the phone is shared across profiles.
 */
export interface InventoryAssignmentChainEntry {
  platformId: string;
  workspaceKey: string;
  workspaceDisplayName: string;
  businessId: string | null;
  businessDisplayName: string | null;
  profileId: string | null;
  profileDisplayName: string | null;
  profileSource: string | null;
  /** profile_phone_assignments.is_default for this entry. */
  isDefault: boolean;
  /** profile_phone_assignments.role (primary | fallback | …). */
  role: string | null;
}

export interface InventoryRow {
  number: string;
  provider: string | null;
  a2pStatus: string | null;
  model: PhoneModelBadge;
  current: InventoryCurrentBlock | null;
  legacy: InventoryLegacyBlock | null;
  /**
   * Resolved chain(s) Platform → Workspace → Business → Profile (PR8).
   * Empty array when the phone has no active profile assignment.
   */
  chain: InventoryAssignmentChainEntry[];
}

export interface LegacyAssignmentGroup {
  businessId: string;
  resolution: 'workspace' | 'tenant' | 'unknown';
  resolvedName: string | null;
  rows: Array<{
    id: string;
    numberE164: string;
    type: 'BOT' | 'DEDICATED';
    region: string | null;
    active: boolean;
    createdAt: string;
  }>;
}

export interface LegacySmsRow {
  id: string;
  businessId: string;
  resolution: 'workspace' | 'tenant' | 'unknown';
  direction: 'INBOUND' | 'OUTBOUND';
  status: string;
  fromNumber: string;
  toNumber: string;
  body: string;
  providerSid: string | null;
  createdAt: string;
}

// ==================== Workspaces (PR8 — customer/account view) ====================

export type WorkspaceKind = 'lb_customer' | 'tenant';

/**
 * One row per *customer* in the admin Workspaces page (PR8).
 *
 * For LeadBridge tenants we group on `communication_businesses.metadata.lb_user_id`
 * (populated by PR6) so all of "Spotless Homes Tampa" / "Jacksonville" / etc.
 * collapse into a single "Spotless Homes" customer row. Non-LB tenants get
 * one row per tenant.
 */
export interface WorkspaceSummary {
  /** Stable synthetic key — `lb-user-<id>` or `tenant-<id>`. Used in URLs / filters. */
  key: string;
  kind: WorkspaceKind;
  displayName: string;
  platformId: string;
  /** LB user id when kind === 'lb_customer'; null otherwise. */
  lbUserId: string | null;
  /** All Sigcore tenant ids that belong to this customer. */
  tenantIds: string[];
  /** Stable representative tenant id for cross-page drill-down. */
  primaryTenantId: string;
  businessCount: number;
  /** Real (non-default) profiles. Default/kept profiles are excluded. */
  profileCount: number;
  phoneCount: number;
  /** PR14 — admin UI classification: 'real_customer' | 'zombie' | 'anchor'. */
  classification: 'real_customer' | 'zombie' | 'anchor';
}

/** PR14 — meta block returned with admin list responses. */
export interface AdminListMeta {
  /** Total records before classification filter. */
  total: number;
  /** Records returned in `data` (after filter + search). */
  visible: number;
  /** Records hidden by the default classification filter, by reason. */
  hiddenZombies: number;
  hiddenAnchors: number;
  /** Profiles only — kept/zombie default profiles hidden by default. */
  hiddenRawDefaults?: number;
}

// ==================== Businesses (PR5) ====================

export interface BusinessSummary {
  id: string;
  displayName: string;
  slug: string;
  status: string;
  externalBusinessId: string | null;
  defaultProfileId: string | null;
  workspaceId: string;
  tenantId: string;
  tenantName: string | null;
  /** Inferred platform via the existing platform-attribution helper. */
  platformId: string;
  profileCount: number;
  phoneCount: number;
  /** Distinct sources across this business's profiles. */
  sources: string[];
  /** True if any profile under this business shares one of its phones with another profile. */
  hasSharedPhone: boolean;
  createdAt: string;
  /**
   * Customer workspace this business belongs to (PR8). Always populated.
   * Format mirrors WorkspaceSummary.key: `lb-user-<id>` or `tenant-<id>`.
   */
  workspaceKey: string;
  /** LB user id when sourced from PR6 metadata; null otherwise. */
  lbUserId: string | null;
  /** Display label for the parent workspace, useful for cross-page links. */
  workspaceDisplayName: string;
  /** Curated location label from PR6 metadata (or null when fallback was used). */
  locationDisplay: string | null;
  /** PR14 — admin UI classification: 'real' | 'zombie'. */
  classification: 'real' | 'zombie';
}

export interface BusinessDetail extends BusinessSummary {
  profiles: ProfileSummary[];
  phones: BusinessPhoneRow[];
}

export interface BusinessPhoneRow {
  tenantPhoneNumberId: string;
  phoneNumber: string;
  provider: string;
  a2pStatus: string | null;
  /** Profiles under this business that have an active assignment to this phone. */
  assignedProfileIds: string[];
  /** True if any other profile (under this business or elsewhere) also has this phone. */
  isShared: boolean;
}

// ==================== Profiles (PR5) ====================

export interface ProfileSummary {
  id: string;
  displayName: string;
  slug: string;
  source: string;
  status: string;
  isDefault: boolean;
  externalProfileId: string | null;
  communicationBusinessId: string;
  businessName: string | null;
  tenantId: string;
  tenantName: string | null;
  workspaceId: string;
  platformId: string;
  phoneCount: number;
  /** True if any of this profile's phones are also assigned to another profile. */
  hasSharedPhone: boolean;
  createdAt: string;
  /** PR14 — admin UI classification: 'real_source' | 'kept_default' | 'zombie_default'. */
  classification: 'real_source' | 'kept_default' | 'zombie_default';
}

export interface ProfilePhoneAssignmentRow {
  id: string;
  tenantPhoneNumberId: string;
  phoneNumber: string;
  provider: string;
  role: string;
  isDefault: boolean;
  priority: number;
  active: boolean;
  /** True if this same phone is assigned to ≥1 other profile (M:N share). */
  isShared: boolean;
  /** Other profiles that share this phone, when isShared = true. */
  sharedWith: Array<{ profileId: string; profileName: string }>;
}

export interface ProfileDetail extends ProfileSummary {
  assignments: ProfilePhoneAssignmentRow[];
  /** Recent inbound/outbound messages for the profile (capped). */
  recentMessages: ProfileRecentMessageRow[];
}

export interface ProfileRecentMessageRow {
  id: string;
  conversationId: string;
  direction: 'in' | 'out' | string;
  fromNumber: string;
  toNumber: string;
  body: string;
  status: string;
  createdAt: string;
}
