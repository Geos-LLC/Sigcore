import { PlatformId } from './dto/admin-views.types';

/**
 * Attribute every tenant in a workspace to one of the four known platforms,
 * or to "unclassified" when no anchor can be matched.
 *
 * From ADMIN_REDESIGN.md §1:
 *   "Introduce 'Platforms' as a UI layer derived from:
 *    - tenants.name OR product_workspaces.product_type."
 *
 * Rule (mandated by the user — wrong attribution is worse than no attribution):
 *
 *   1. ANCHOR — a tenant whose `name` exactly matches one of
 *      `LeadBridge` / `HireFunnel` / `Service Flow` / `Callio`
 *      (case-insensitive, trimmed) is the anchor for that platform.
 *      The platform inherits the anchor's tenant id.
 *
 *   2. ATTRIBUTION via api_keys — for every other tenant, look at the
 *      tenant_id on every api_key tied to it. If any of those api_keys
 *      shares its tenant_id with a known anchor (i.e. the anchor has its
 *      own api_keys), attribute that platform.  This is reserved for the
 *      future when we have richer signal; today it is a no-op because
 *      api_keys.tenant_id and tenants.id are 1:1.
 *
 *   3. DEFAULT — any tenant that is neither an anchor nor a positively
 *      attributed row is "unclassified".  Do NOT silently default to
 *      LeadBridge or any other platform.  Operators surface those rows
 *      in the admin UI and reclassify by hand.
 *
 * This function is pure — no I/O, no logging.  All inputs are passed in.
 * Live the rule here so it's testable in one file.
 */

export interface AttributionTenant {
  id: string;
  name: string;
}

/** Anchors live here so the test file can assert against them. */
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

export interface AttributionResult {
  /** tenantId → PlatformId */
  byTenantId: Map<string, PlatformId>;
  /** PlatformId → anchor tenantId (or null when no anchor exists in this workspace) */
  anchors: Record<PlatformId, string | null>;
}

/**
 * Compute the attribution for a list of tenants.
 *
 * @param tenants  All tenants under the calling workspace.
 * @returns        A map of tenantId → PlatformId plus the anchor index.
 */
export function attributePlatforms(tenants: AttributionTenant[]): AttributionResult {
  const byTenantId = new Map<string, PlatformId>();
  const anchors: Record<PlatformId, string | null> = {
    leadbridge: null,
    hirefunnel: null,
    serviceflow: null,
    callio: null,
    unclassified: null, // never has an anchor
  };

  // Pass 1 — find anchors.
  for (const t of tenants) {
    const normalized = (t.name || '').trim().toLowerCase();
    for (const [platformId, anchorName] of Object.entries(PLATFORM_ANCHORS) as Array<
      [Exclude<PlatformId, 'unclassified'>, string]
    >) {
      if (normalized === anchorName && anchors[platformId] === null) {
        anchors[platformId] = t.id;
        byTenantId.set(t.id, platformId);
        break;
      }
    }
  }

  // Pass 2 — every non-anchor tenant is "unclassified" by default.
  for (const t of tenants) {
    if (!byTenantId.has(t.id)) {
      byTenantId.set(t.id, 'unclassified');
    }
  }

  return { byTenantId, anchors };
}

/**
 * Reverse view of the attribution: PlatformId → tenantId[].
 * Useful for COUNT queries grouped per-platform.
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
