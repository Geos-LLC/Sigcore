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

export interface InventoryRow {
  number: string;
  provider: string | null;
  a2pStatus: string | null;
  model: PhoneModelBadge;
  current: InventoryCurrentBlock | null;
  legacy: InventoryLegacyBlock | null;
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
