import { PlatformId } from './dto/admin-views.types';

/**
 * Attribute every tenant in a workspace to one of the four known platforms,
 * or to "unclassified" when no signal matches.
 *
 * From ADMIN_REDESIGN.md §1:
 *   "Introduce 'Platforms' as a UI layer derived from:
 *    - tenants.name OR product_workspaces.product_type."
 *
 * User rule (mandatory): wrong attribution is worse than no attribution.
 *   - Never silently default to LeadBridge (or any other platform).
 *   - If no signal matches, the tenant is "unclassified".
 *
 * Priority order (highest signal wins; ties resolved in declaration order):
 *   1. anchor_name              — tenants.name exactly matches a platform anchor
 *   2. product_workspace:<type> — product_workspaces.product_type ∈
 *                                 {leadbridge, serviceflow, callio}.
 *                                 'sigcore' is NOT a signal — it just means
 *                                 the tenant was registered as its own business
 *                                 identity.
 *   3. webhook_url:<host>       — any webhook subscription URL contains a
 *                                 known platform hostname token
 *   4. api_key_name:<token>     — any api_key.name contains a known token
 *   5. unclassified             — fallthrough; the user must classify by hand
 *
 * The result also returns the *reason* per tenant (e.g. 'anchor_name',
 * 'product_workspace:leadbridge', 'webhook_url:thumbtack-bridge') so the UI
 * can show how confident we are about each attribution.
 *
 * This function is pure — no I/O, no logging.  All inputs are passed in.
 */

export interface AttributionTenant {
  id: string;
  name: string;
  /** product_workspaces.product_type joined via tenants.product_workspace_id (nullable). */
  productWorkspaceProductType?: string | null;
  /** webhook_subscriptions.webhook_url for every subscription tied to this tenant. */
  webhookUrls?: string[];
  /** api_keys.name for every key tied to this tenant. */
  apiKeyNames?: string[];
}

/** Anchor names live here so the test file can assert against them. */
export const PLATFORM_ANCHORS: Record<Exclude<PlatformId, 'unclassified'>, string> = {
  leadbridge: 'leadbridge',
  hirefunnel: 'hirefunnel',
  serviceflow: 'service flow',
  callio: 'callio',
};

export const PLATFORM_DISPLAY_NAMES: Record<PlatformId, string> = {
  leadbridge: 'LeadBridge',
  hirefunnel: 'HireFunnel',
  serviceflow: 'ServiceFlow',
  callio: 'Callio',
  unclassified: 'Unclassified',
};

/**
 * product_workspaces.product_type → PlatformId mapping.
 * Note: 'sigcore' is intentionally absent — it's a registry artifact, not a
 * platform attribution signal.
 */
const PRODUCT_TYPE_MAP: Record<string, PlatformId> = {
  leadbridge: 'leadbridge',
  serviceflow: 'serviceflow',
  callio: 'callio',
  // intentionally NOT: sigcore, hirefunnel (HF isn't in the enum)
};

/**
 * Webhook URL host patterns. Iterated in declaration order so a tenant with
 * conflicting webhooks (e.g. one pointing at LB and another at SF) gets a
 * deterministic answer regardless of webhook insertion order.
 */
const WEBHOOK_HOST_PATTERNS: Array<{
  pattern: RegExp;
  platform: PlatformId;
  reasonToken: string;
}> = [
  { pattern: /thumbtack-bridge/i,      platform: 'leadbridge',  reasonToken: 'thumbtack-bridge'      },
  { pattern: /leadbridge360/i,          platform: 'leadbridge',  reasonToken: 'leadbridge360'         },
  { pattern: /hirefunnel/i,             platform: 'hirefunnel',  reasonToken: 'hirefunnel'            },
  { pattern: /hiringflow/i,             platform: 'hirefunnel',  reasonToken: 'hiringflow'            },
  { pattern: /service-flow-backend/i,   platform: 'serviceflow', reasonToken: 'service-flow-backend'  },
  { pattern: /callio-production/i,      platform: 'callio',      reasonToken: 'callio-production'     },
];

/**
 * api_key.name patterns. Same iteration rule as webhooks.
 */
const API_KEY_NAME_PATTERNS: Array<{
  pattern: RegExp;
  platform: PlatformId;
  reasonToken: string;
}> = [
  { pattern: /lead\s*bridge/i,  platform: 'leadbridge',  reasonToken: 'leadbridge'  },
  { pattern: /hire\s*funnel/i,  platform: 'hirefunnel',  reasonToken: 'hirefunnel'  },
  { pattern: /hiring\s*flow/i,  platform: 'hirefunnel',  reasonToken: 'hiringflow'  },
  { pattern: /service\s*flow/i, platform: 'serviceflow', reasonToken: 'serviceflow' },
  { pattern: /callio/i,          platform: 'callio',      reasonToken: 'callio'      },
];

export interface AttributionResult {
  /** tenantId → PlatformId */
  byTenantId: Map<string, PlatformId>;
  /** tenantId → reason string (e.g. 'anchor_name', 'webhook_url:thumbtack-bridge') */
  reasonByTenantId: Map<string, string>;
  /** PlatformId → anchor tenantId (or null when no anchor exists) */
  anchors: Record<PlatformId, string | null>;
}

const REASON_UNCLASSIFIED = 'unclassified';

/**
 * Compute the attribution for a list of tenants with their signal bundles.
 *
 * Each tenant gets exactly one PlatformId and one reason.  Highest-priority
 * signal wins; "unclassified" is the explicit fallthrough.
 */
export function attributePlatforms(tenants: AttributionTenant[]): AttributionResult {
  const byTenantId = new Map<string, PlatformId>();
  const reasonByTenantId = new Map<string, string>();
  const anchors: Record<PlatformId, string | null> = {
    leadbridge: null,
    hirefunnel: null,
    serviceflow: null,
    callio: null,
    unclassified: null, // never has an anchor
  };

  for (const t of tenants) {
    const { platform, reason } = classifyTenant(t, anchors);
    byTenantId.set(t.id, platform);
    reasonByTenantId.set(t.id, reason);
  }

  return { byTenantId, reasonByTenantId, anchors };
}

function classifyTenant(
  t: AttributionTenant,
  anchors: Record<PlatformId, string | null>,
): { platform: PlatformId; reason: string } {
  // Signal 1 — anchor by name.
  const normalized = (t.name || '').trim().toLowerCase();
  for (const [platformId, anchorName] of Object.entries(PLATFORM_ANCHORS) as Array<
    [Exclude<PlatformId, 'unclassified'>, string]
  >) {
    if (normalized === anchorName) {
      // Record first anchor we see for each platform (helps PlatformDetail).
      if (anchors[platformId] === null) anchors[platformId] = t.id;
      return { platform: platformId, reason: 'anchor_name' };
    }
  }

  // Signal 2 — product_workspaces.product_type (sigcore excluded).
  const productType = (t.productWorkspaceProductType || '').trim().toLowerCase();
  if (productType && PRODUCT_TYPE_MAP[productType]) {
    const platform = PRODUCT_TYPE_MAP[productType];
    return { platform, reason: `product_workspace:${productType}` };
  }

  // Signal 3 — webhook URL hostname patterns.
  if (t.webhookUrls && t.webhookUrls.length > 0) {
    for (const { pattern, platform, reasonToken } of WEBHOOK_HOST_PATTERNS) {
      if (t.webhookUrls.some((u) => u && pattern.test(u))) {
        return { platform, reason: `webhook_url:${reasonToken}` };
      }
    }
  }

  // Signal 4 — api_key.name patterns.
  if (t.apiKeyNames && t.apiKeyNames.length > 0) {
    for (const { pattern, platform, reasonToken } of API_KEY_NAME_PATTERNS) {
      if (t.apiKeyNames.some((n) => n && pattern.test(n))) {
        return { platform, reason: `api_key_name:${reasonToken}` };
      }
    }
  }

  return { platform: 'unclassified', reason: REASON_UNCLASSIFIED };
}

/**
 * Reverse view of the attribution: PlatformId → tenantId[].
 */
export function tenantsByPlatform(
  result: AttributionResult,
): Record<PlatformId, string[]> {
  const out: Record<PlatformId, string[]> = {
    leadbridge: [],
    hirefunnel: [],
    serviceflow: [],
    callio: [],
    unclassified: [],
  };
  for (const [tenantId, platformId] of result.byTenantId.entries()) {
    out[platformId].push(tenantId);
  }
  return out;
}
