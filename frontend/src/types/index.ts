// ==================== Admin Types ====================

export interface Tenant {
  id: string;
  workspaceId: string;
  externalId: string;
  name: string;
  status: 'active' | 'inactive' | 'suspended';
  webhookSecret?: string;
  metadata?: Record<string, unknown>;
  phoneNumbers?: TenantPhoneNumber[];
  createdAt: string;
  updatedAt: string;
}

export interface TenantPhoneNumber {
  id: string;
  workspaceId: string;
  tenantId: string;
  phoneNumber: string;
  friendlyName?: string;
  provider: 'twilio' | 'openphone' | 'whatsapp';
  providerId?: string;
  channel: 'sms' | 'whatsapp' | 'voice';
  status: 'active' | 'inactive' | 'pending';
  isDefault: boolean;
  metadata?: Record<string, unknown>;
  a2pStatus?: string;
  messagingServiceSid?: string;
  a2pAttachedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AvailablePhoneNumber {
  phoneNumber: string;
  friendlyName: string | null;
  provider: 'twilio' | 'openphone' | 'whatsapp';
  providerId: string;
  capabilities?: string[];
  allocated: boolean;
  allocatedTo?: {
    tenantId: string;
    tenantName: string;
  };
}

export interface CreateTenantDto {
  externalId?: string;
  name: string;
  metadata?: Record<string, unknown>;
}

export interface AllocatePhoneNumberDto {
  phoneNumber: string;
  provider: 'twilio' | 'openphone' | 'whatsapp';
  providerId?: string;
  friendlyName?: string;
  channel?: 'sms' | 'whatsapp' | 'voice';
  isDefault?: boolean;
  metadata?: Record<string, unknown>;
}

export interface PricingConfig {
  pricingType: 'fixed_markup' | 'percentage_markup' | 'fixed_price';
  monthlyBasePrice?: number;
  monthlyMarkupAmount: number;
  monthlyMarkupPercentage: number;
  setupFee: number;
  allowTenantPurchase: boolean;
  allowTenantRelease: boolean;
  messagingServiceSid?: string;
}

export interface UpdatePricingConfigDto {
  pricingType?: string;
  monthlyBasePrice?: number;
  monthlyMarkupAmount?: number;
  monthlyMarkupPercentage?: number;
  setupFee?: number;
  allowTenantPurchase?: boolean;
  allowTenantRelease?: boolean;
  messagingServiceSid?: string;
}

export interface PhoneNumberOrder {
  id: string;
  workspaceId: string;
  tenantId?: string;
  phoneNumber?: string;
  phoneNumberSid?: string;
  orderType: 'purchase' | 'release';
  status: 'pending' | 'provisioning' | 'active' | 'releasing' | 'released' | 'failed' | 'cancelled';
  twilioCost?: number;
  markupAmount?: number;
  totalPrice?: number;
  orderedBy?: string;
  tenantPhoneNumberId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  tenant?: Tenant;
}

export interface TenantApiKeyResponse {
  id: string;
  name: string;
  key: string;
  scope: string;
  createdAt: string;
}

export interface TenantApiKeyInfo {
  id: string;
  name: string;
  key?: string;
  keyPreview: string;
  active: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface WorkspaceApiKey {
  id: string;
  name: string;
  keyPreview: string;
  scope: string;
  active: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface WorkspaceApiKeyCreateResponse {
  apiKey: WorkspaceApiKey;
  fullKey: string;
}

// ==================== Portal Types ====================

export interface PortalTenantProfile {
  id: string;
  name: string;
  externalId: string;
  status: 'active' | 'inactive' | 'suspended';
  createdAt: string;
  updatedAt?: string;
  phoneNumberCount: number;
}

export interface PortalApiKeyInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface PortalAuthResponse {
  tenant: PortalTenantProfile;
  apiKey: PortalApiKeyInfo;
}

export interface PortalPhoneNumber {
  id: string;
  phoneNumber: string;
  friendlyName?: string;
  provider: 'twilio' | 'openphone' | 'whatsapp';
  channel: 'sms' | 'whatsapp' | 'voice';
  status: 'active' | 'inactive' | 'pending';
  isDefault: boolean;
  provisionedViaCallio: boolean;
  monthlyCost?: number;
  provisionedAt?: string;
  a2pStatus?: string;
  messagingServiceSid?: string;
  a2pAttachedAt?: string;
  createdAt: string;
}

export interface PortalOrder {
  id: string;
  workspaceId: string;
  tenantId?: string;
  phoneNumber?: string;
  orderType: 'purchase' | 'release';
  status: string;
  twilioCost?: number;
  markupAmount?: number;
  totalPrice?: number;
  createdAt: string;
  completedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface PortalBilling {
  pricing: {
    pricingType: string;
    setupFee: number;
  };
  summary: {
    activeNumbers: number;
    provisionedNumbers: number;
    totalMonthlyCost: number;
    totalOrders: number;
    totalSpent: number;
  };
}

// ==================== Admin Views (read-only) ====================
// Mirror of backend/src/modules/admin-views/dto/admin-views.types.ts
// Keep in sync with the wire format if either side changes.

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
   *   'anchor_name'              — tenants.name == platform anchor
   *   'product_workspace:<type>' — product_workspaces.product_type
   *   'webhook_url:<host-token>' — webhook URL hostname pattern
   *   'api_key_name:<token>'     — api_keys.name pattern
   *   'unclassified'             — no signal matched
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
 * Profile under a customer workspace. Multiple tenants with the same
 * (case-insensitive) profile name collapse into one row with duplicateCount > 1.
 * Mirrors backend ProfileRow.
 */
export interface ProfileRow {
  name: string;
  duplicateCount: number;
  tenantIds: string[];
  phoneNumbersCount: number;
  hasLegacy: boolean;
  hasCurrent: boolean;
  attributionReasons: string[];
}

export type WorkspaceGroupSource =
  | 'business_identity'
  | 'name_prefix'
  | 'standalone';

/**
 * Customer workspace inferred from tenant signals. UI-only, derived layer —
 * no schema change. Mirrors backend WorkspaceGroup.
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
}

export interface PlatformDetail extends PlatformSummary {
  workspaces: PlatformWorkspaceRow[];
  /**
   * Customer workspace grouping (derived). Additive on the wire — the
   * flat `workspaces` array is unchanged.
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

export interface InventoryFilters {
  model?: PhoneModelBadge;
  provider?: string;
  limit?: number;
}

export interface LegacyAssignmentRow {
  id: string;
  numberE164: string;
  type: 'BOT' | 'DEDICATED';
  region: string | null;
  active: boolean;
  createdAt: string;
}

export interface LegacyAssignmentGroup {
  businessId: string;
  resolution: 'workspace' | 'tenant' | 'unknown';
  resolvedName: string | null;
  rows: LegacyAssignmentRow[];
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

// ==================== Common ====================

export interface ApiResponse<T> {
  data: T;
}
