/**
 * Group platform tenants into customer workspaces and profiles.
 *
 * UI-only / derived layer — no schema, no writes. Operates on inputs the
 * service has already loaded.
 *
 * Hierarchy produced:
 *   Platform → Workspace (customer) → Profile (location/identity) → tenants
 *
 * Grouping priority (highest signal wins):
 *
 *   1. business_identity_id
 *      Tenants sharing a non-null business_identity_id are grouped under
 *      a single workspace named after the linked business.  Profile names
 *      are taken from the tenant.name (full).
 *
 *   2. name prefix fallback
 *      For tenants whose business_identity_id is null, walk a hand-picked
 *      list of canonical customer prefixes (case-insensitive, word-boundary):
 *        spotless homes, natashahome, lavanda cleaning,
 *        abc solutions, scandinavian cleaning, brilliant clean home
 *      A match groups the tenant under the canonical workspace name; the
 *      profile name is the remainder of the tenant.name with leading
 *      separators trimmed.  An exact-match (no remainder) reuses the
 *      canonical name as the profile name.
 *
 *   3. standalone
 *      Tenant becomes its own workspace and its only profile.  This is the
 *      explicit fallthrough — never silently merged with anything else.
 *
 * Within each workspace, profiles are deduped by case-insensitive trimmed
 * profile name.  Multiple tenants resolving to the same profile name
 * collapse into a single ProfileRow with duplicateCount > 1 and tenantIds
 * carrying every contributing tenant id.
 *
 * Pure function — no I/O.  Add new prefixes here, not at call sites.
 */

export type WorkspaceGroupSource =
  | 'business_identity'
  | 'name_prefix'
  | 'standalone';

export interface ProfileRow {
  /** Display name for the profile. Cased from the first contributing tenant. */
  name: string;
  /** Number of underlying tenant rows that collapsed into this profile. */
  duplicateCount: number;
  /** All contributing tenant ids, oldest first. */
  tenantIds: string[];
  /** Sum of tenant_phone_numbers rows across all contributing tenants. */
  phoneNumbersCount: number;
  /** True if any contributing tenant is referenced by phone_number_assignments. */
  hasLegacy: boolean;
  /** True if any contributing tenant has at least one tenant_phone_numbers row. */
  hasCurrent: boolean;
  /** Unique attribution reasons across the profile's tenants. */
  attributionReasons: string[];
}

export interface WorkspaceGroup {
  /** Display name for the workspace. */
  name: string;
  /** Which rule produced this group. */
  source: WorkspaceGroupSource;
  /** When source = 'business_identity', the FK that grouped these tenants. */
  businessIdentityId: string | null;
  /** Profiles belonging to this workspace, alphabetical by name. */
  profiles: ProfileRow[];
  /** Total profiles after dedup. */
  profileCount: number;
  /** Total tenants underlying all profiles (including duplicates). */
  totalTenantCount: number;
  /** Total tenant_phone_numbers rows across this workspace. */
  totalPhoneNumbersCount: number;
  /** Unique attribution reasons across the workspace. */
  attributionReasons: string[];
}

export interface GroupingTenant {
  id: string;
  name: string;
  businessIdentityId?: string | null;
  attributionReason: string;
  phoneNumbersCount: number;
  hasLegacy: boolean;
  hasCurrent: boolean;
}

export interface GroupingBusiness {
  id: string;
  name: string;
}

export interface GroupingResult {
  groups: WorkspaceGroup[];
}

const KNOWN_CUSTOMER_PREFIXES: Array<{ pattern: RegExp; canonicalName: string }> = [
  { pattern: /^spotless\s+homes\b/i,        canonicalName: 'Spotless Homes' },
  { pattern: /^natashahome\b/i,              canonicalName: 'NatashaHome' },
  { pattern: /^lavanda\s+cleaning\b/i,       canonicalName: 'Lavanda Cleaning' },
  { pattern: /^abc\s+solutions\b/i,          canonicalName: 'ABC Solutions' },
  { pattern: /^scandinavian\s+cleaning\b/i,  canonicalName: 'Scandinavian cleaning' },
  { pattern: /^brilliant\s+clean\s+home\b/i, canonicalName: 'Brilliant Clean Home' },
];

interface PreGroup {
  source: WorkspaceGroupSource;
  groupKey: string;            // stable identity for the workspace
  workspaceName: string;
  businessIdentityId: string | null;
  profileName: string;         // pre-dedup profile name
  tenant: GroupingTenant;
}

export function groupWorkspaces(
  tenants: GroupingTenant[],
  businessesById: Map<string, GroupingBusiness>,
): GroupingResult {
  // Pass 1 — classify every tenant into a (workspace, profile) pair.
  const pre: PreGroup[] = [];
  for (const t of tenants) {
    pre.push(classifyTenant(t, businessesById));
  }

  // Pass 2 — bucket by workspace groupKey, preserving order of first
  // occurrence so the output is deterministic w.r.t. input order.
  const byKey = new Map<string, PreGroup[]>();
  for (const g of pre) {
    const list = byKey.get(g.groupKey) ?? [];
    list.push(g);
    byKey.set(g.groupKey, list);
  }

  // Pass 3 — within each workspace, dedup profiles by case-insensitive name.
  const groups: WorkspaceGroup[] = [];
  for (const [, members] of byKey) {
    const head = members[0];
    const profiles = collapseProfiles(members);

    const totalTenantCount = profiles.reduce((acc, p) => acc + p.duplicateCount, 0);
    const totalPhoneNumbersCount = profiles.reduce(
      (acc, p) => acc + p.phoneNumbersCount,
      0,
    );
    const attributionReasons = uniqueStable(
      members.map((m) => m.tenant.attributionReason).filter((r) => Boolean(r)),
    );

    groups.push({
      name: head.workspaceName,
      source: head.source,
      businessIdentityId: head.businessIdentityId,
      profiles: profiles.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      ),
      profileCount: profiles.length,
      totalTenantCount,
      totalPhoneNumbersCount,
      attributionReasons,
    });
  }

  // Stable sort: business_identity first, then name_prefix, then standalone;
  // alphabetical within each band.
  const sourceRank: Record<WorkspaceGroupSource, number> = {
    business_identity: 0,
    name_prefix: 1,
    standalone: 2,
  };
  groups.sort((a, b) => {
    const r = sourceRank[a.source] - sourceRank[b.source];
    if (r !== 0) return r;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return { groups };
}

function classifyTenant(
  t: GroupingTenant,
  businessesById: Map<string, GroupingBusiness>,
): PreGroup {
  // Rule 1 — business_identity_id.
  const bid = t.businessIdentityId?.trim();
  if (bid) {
    const biz = businessesById.get(bid);
    const workspaceName = biz?.name?.trim() || `(business ${bid.slice(0, 8)}…)`;
    return {
      source: 'business_identity',
      groupKey: `bi:${bid}`,
      workspaceName,
      businessIdentityId: bid,
      profileName: (t.name || '').trim() || workspaceName,
      tenant: t,
    };
  }

  // Rule 2 — name prefix.
  const name = (t.name || '').trim();
  const lc = name.toLowerCase();
  for (const { pattern, canonicalName } of KNOWN_CUSTOMER_PREFIXES) {
    const match = lc.match(pattern);
    if (match) {
      const matchedLength = match[0].length;
      // Use the original-cased remainder so casing is preserved per profile.
      const remainder = name.slice(matchedLength).replace(/^[\s\-:_.,]+/, '').trim();
      const profileName = remainder.length > 0 ? remainder : canonicalName;
      return {
        source: 'name_prefix',
        groupKey: `np:${canonicalName.toLowerCase()}`,
        workspaceName: canonicalName,
        businessIdentityId: null,
        profileName,
        tenant: t,
      };
    }
  }

  // Rule 3 — standalone fallthrough.
  const standaloneName = name || `(unnamed ${t.id.slice(0, 8)}…)`;
  return {
    source: 'standalone',
    groupKey: `sa:${t.id}`,
    workspaceName: standaloneName,
    businessIdentityId: null,
    profileName: standaloneName,
    tenant: t,
  };
}

function collapseProfiles(members: PreGroup[]): ProfileRow[] {
  const byProfileKey = new Map<string, PreGroup[]>();
  for (const m of members) {
    const key = m.profileName.trim().toLowerCase();
    const list = byProfileKey.get(key) ?? [];
    list.push(m);
    byProfileKey.set(key, list);
  }

  const profiles: ProfileRow[] = [];
  for (const [, dupGroup] of byProfileKey) {
    const head = dupGroup[0];
    const tenantIds = dupGroup.map((d) => d.tenant.id);
    const phoneNumbersCount = dupGroup.reduce((a, d) => a + d.tenant.phoneNumbersCount, 0);
    const hasLegacy = dupGroup.some((d) => d.tenant.hasLegacy);
    const hasCurrent = dupGroup.some((d) => d.tenant.hasCurrent);
    const attributionReasons = uniqueStable(
      dupGroup.map((d) => d.tenant.attributionReason).filter(Boolean),
    );
    profiles.push({
      name: head.profileName,
      duplicateCount: dupGroup.length,
      tenantIds,
      phoneNumbersCount,
      hasLegacy,
      hasCurrent,
      attributionReasons,
    });
  }
  return profiles;
}

function uniqueStable(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of arr) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}
