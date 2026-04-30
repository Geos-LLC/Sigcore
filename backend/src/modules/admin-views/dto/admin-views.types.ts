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

export interface PlatformDetail extends PlatformSummary {
  workspaces: PlatformWorkspaceRow[];
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
