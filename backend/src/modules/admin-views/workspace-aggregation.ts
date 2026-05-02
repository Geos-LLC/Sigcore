/**
 * Customer-workspace aggregation for the admin redesign (PR8).
 *
 * The admin hierarchy is:
 *
 *   Platform → Workspace (customer/account) → Business (location) → Profile (source) → Phone
 *
 * The Workspaces page shows one row per *customer*, not per Sigcore tenant.
 * For LeadBridge the customer key lives on `communication_businesses.metadata.lb_user_id`
 * (populated by PR6 materialization) — many tenants under one LB user collapse
 * to a single row. For non-LB platforms each tenant is its own customer.
 *
 * This helper is pure — no I/O, no DB calls. The backend service feeds it
 * tenants + businesses (with metadata) + a platform attribution map; this
 * file does the grouping.
 */
import { CommunicationBusiness } from '../../database/entities/communication-business.entity';

export interface AggregationTenant {
  id: string;
  name: string | null;
  workspaceId: string;
  /** Platform id resolved by attributePlatforms() — kept opaque here. */
  platformId: string;
}

export interface AggregationBusiness {
  id: string;
  tenantId: string;
  workspaceId: string;
  displayName: string;
  /** Whole metadata bag from PR6 (lb_user_id, lb_organization_id, location_display, …). */
  metadata: Record<string, unknown> | null;
}

export interface AggregationProfileCounts {
  /** profile_id → its business_id (for counting profiles per workspace). */
  byProfileId: Map<string, { businessId: string; tenantId: string }>;
  /** business_id → number of NON-default profiles (i.e. real materialized ones). */
  realProfilesPerBusiness: Map<string, number>;
  /** business_id → number of profiles total (including kept defaults). */
  allProfilesPerBusiness: Map<string, number>;
}

export interface AggregationPhoneCounts {
  /** business_id → set of distinct phone numbers active under it. */
  phonesPerBusiness: Map<string, Set<string>>;
  /** workspace key → bool — true if any phone under this workspace is shared with another profile in same workspace. */
  sharedPhoneByWorkspace?: Map<string, boolean>;
}

export type WorkspaceKind = 'lb_customer' | 'tenant';

export interface WorkspaceSummary {
  /** Synthetic stable key. Format: 'lb-user-<lb_user_id>' or 'tenant-<tenantId>'. */
  key: string;
  kind: WorkspaceKind;
  /** Display label, e.g. "Spotless Homes" / "ABC Solutions" / "<tenant.name>". */
  displayName: string;
  platformId: string;
  /** LB user id when kind === 'lb_customer'; null otherwise. */
  lbUserId: string | null;
  /** All Sigcore tenant ids that belong to this workspace. */
  tenantIds: string[];
  /** A representative tenant id for drill-down — the first one in stable order. */
  primaryTenantId: string;
  businessCount: number;
  /** Real (non-default) profiles. Default/kept profiles are excluded. */
  profileCount: number;
  phoneCount: number;
}

/**
 * Pick a display name for an LB customer workspace from the businesses
 * grouped under the same `lb_user_id`. We prefer:
 *   1. metadata.workspace_display_name (operator-set, future)
 *   2. The shortest businessName that contains spaces (likely the brand,
 *      e.g. "Spotless Homes" beats "Spotless Homes Tampa")
 *   3. The first business display_name as a fallback
 */
export function pickLbCustomerDisplayName(
  businesses: AggregationBusiness[],
): string {
  if (businesses.length === 0) return 'Unknown';

  // 1. Operator override on any business in the group
  for (const b of businesses) {
    const meta = b.metadata ?? {};
    const v = meta.workspace_display_name ?? meta.workspaceDisplayName;
    if (typeof v === 'string' && v.trim()) return v.trim();
  }

  // 2. Prefer the shortest spaced name — it's usually the brand.
  // Sort by length asc, prefer names with a space (multi-word brands), then alpha.
  const candidates = businesses
    .map((b) => (b.displayName ?? '').trim())
    .filter((n) => n.length > 0);
  if (candidates.length === 0) return 'Unknown';

  candidates.sort((a, b) => {
    const aSpaced = a.includes(' ');
    const bSpaced = b.includes(' ');
    if (aSpaced !== bSpaced) return aSpaced ? -1 : 1;
    const lenDiff = a.length - b.length;
    if (lenDiff !== 0) return lenDiff;
    return a.localeCompare(b);
  });
  return candidates[0];
}

/**
 * Group tenants + businesses into customer workspaces.
 *
 * Rules:
 *   - A business with `metadata.lb_user_id` (string) joins the LB-customer
 *     workspace keyed by that id. All sibling LB-user businesses (across
 *     multiple tenants) collapse into one workspace row.
 *   - Any tenant whose businesses have no `lb_user_id` becomes its own
 *     workspace row. (Non-LB tenants, or LB tenants where PR6 hasn't run.)
 *   - Tenants with NO businesses also get a fallback row keyed by tenant id.
 *
 * Pure — no I/O. Caller owns the DB reads.
 */
export function aggregateWorkspaces(
  tenants: AggregationTenant[],
  businesses: AggregationBusiness[],
  profileCounts: AggregationProfileCounts,
  phoneCounts: AggregationPhoneCounts,
): WorkspaceSummary[] {
  const tenantById = new Map(tenants.map((t) => [t.id, t]));

  // Bucket businesses by their workspace key.
  const buckets = new Map<
    string,
    {
      kind: WorkspaceKind;
      lbUserId: string | null;
      platformId: string;
      tenantIds: Set<string>;
      businesses: AggregationBusiness[];
    }
  >();

  for (const b of businesses) {
    const lbUserId = readStringMeta(b.metadata, 'lb_user_id');
    const tenant = tenantById.get(b.tenantId);
    if (!tenant) continue; // dangling business (shouldn't happen post-FK)

    let key: string;
    let kind: WorkspaceKind;
    if (lbUserId) {
      key = `lb-user-${lbUserId}`;
      kind = 'lb_customer';
    } else {
      key = `tenant-${b.tenantId}`;
      kind = 'tenant';
    }

    const bucket = buckets.get(key) ?? {
      kind,
      lbUserId: lbUserId ?? null,
      platformId: tenant.platformId,
      tenantIds: new Set<string>(),
      businesses: [] as AggregationBusiness[],
    };
    bucket.tenantIds.add(b.tenantId);
    bucket.businesses.push(b);
    buckets.set(key, bucket);
  }

  // Tenants with no businesses → fallback solo workspace.
  for (const t of tenants) {
    const key = `tenant-${t.id}`;
    if (!buckets.has(key) && !hasLbBusinessForTenant(businesses, t.id)) {
      buckets.set(key, {
        kind: 'tenant',
        lbUserId: null,
        platformId: t.platformId,
        tenantIds: new Set([t.id]),
        businesses: [],
      });
    }
  }

  // Materialize summaries.
  const out: WorkspaceSummary[] = [];
  for (const [key, bucket] of buckets) {
    const tenantIds = Array.from(bucket.tenantIds).sort();
    const primaryTenantId = tenantIds[0];
    const displayName =
      bucket.kind === 'lb_customer'
        ? pickLbCustomerDisplayName(bucket.businesses)
        : tenantById.get(primaryTenantId)?.name?.trim() ||
          `Tenant ${primaryTenantId.slice(0, 8)}`;

    let profileCount = 0;
    const phoneSet = new Set<string>();
    for (const b of bucket.businesses) {
      profileCount += profileCounts.realProfilesPerBusiness.get(b.id) ?? 0;
      const phones = phoneCounts.phonesPerBusiness.get(b.id);
      if (phones) for (const p of phones) phoneSet.add(p);
    }

    out.push({
      key,
      kind: bucket.kind,
      displayName,
      platformId: bucket.platformId,
      lbUserId: bucket.lbUserId,
      tenantIds,
      primaryTenantId,
      businessCount: bucket.businesses.length,
      profileCount,
      phoneCount: phoneSet.size,
    });
  }

  // Stable order: by displayName asc, key asc as tiebreaker.
  out.sort((a, b) => {
    const n = a.displayName.localeCompare(b.displayName);
    if (n !== 0) return n;
    return a.key.localeCompare(b.key);
  });
  return out;
}

function hasLbBusinessForTenant(
  businesses: AggregationBusiness[],
  tenantId: string,
): boolean {
  return businesses.some(
    (b) => b.tenantId === tenantId && readStringMeta(b.metadata, 'lb_user_id'),
  );
}

function readStringMeta(
  meta: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  if (!meta) return null;
  const v = meta[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Filter a list of CommunicationBusiness entities down to the workspace key
 * convention used by aggregateWorkspaces — exposed so the controller can
 * answer drill-down queries like "give me all businesses in this workspace".
 */
export function workspaceKeyForBusiness(
  business: Pick<CommunicationBusiness, 'tenantId' | 'metadata'>,
): string {
  const lbUserId = readStringMeta(business.metadata ?? null, 'lb_user_id');
  return lbUserId ? `lb-user-${lbUserId}` : `tenant-${business.tenantId}`;
}
