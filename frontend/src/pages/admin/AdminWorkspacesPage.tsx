import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Building2,
  MapPin,
  Phone,
  Layers,
  RefreshCw,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Search,
  HelpCircle,
  Archive,
  CheckCircle2,
  Filter,
  X,
} from 'lucide-react';
import { adminApi } from '../../services/adminApi';
import type {
  PlatformDetail,
  PlatformId,
  PlatformSummary,
  ProfileRow,
  WorkspaceGroup,
} from '../../types';

interface PlatformBucket {
  id: PlatformId;
  name: string;
  summary: PlatformSummary;
  groups: WorkspaceGroup[];
}

const PLATFORM_ORDER: PlatformId[] = [
  'leadbridge',
  'hirefunnel',
  'serviceflow',
  'callio',
  'unclassified',
];

export default function AdminWorkspacesPage() {
  const [buckets, setBuckets] = useState<PlatformBucket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // filters
  const [platformFilter, setPlatformFilter] = useState<PlatformId | ''>('');
  const [hasPhones, setHasPhones] = useState(false);
  const [hasDuplicates, setHasDuplicates] = useState(false);
  const [unclassifiedOnly, setUnclassifiedOnly] = useState(false);
  const [search, setSearch] = useState('');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const summaries = await adminApi.getPlatforms();
      const ordered = [...summaries].sort(
        (a, b) => PLATFORM_ORDER.indexOf(a.id) - PLATFORM_ORDER.indexOf(b.id),
      );
      const details = await Promise.all(
        ordered.map((s) => adminApi.getPlatform(s.id)),
      );
      const bucketsOut: PlatformBucket[] = ordered.map((s, i) => ({
        id: s.id,
        name: s.name,
        summary: s,
        groups: (details[i] as PlatformDetail).workspaceGroups ?? [],
      }));
      setBuckets(bucketsOut);
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Failed to load workspaces');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  // Apply filters & search.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return buckets
      .filter((b) => !platformFilter || b.id === platformFilter)
      .filter((b) => !unclassifiedOnly || b.id === 'unclassified')
      .map((b) => ({
        ...b,
        groups: b.groups
          .filter((g) => !hasPhones || g.totalPhoneNumbersCount > 0)
          .filter(
            (g) => !hasDuplicates || g.profiles.some((p) => p.duplicateCount > 1),
          )
          .filter((g) => {
            if (!q) return true;
            if (g.name.toLowerCase().includes(q)) return true;
            if ((g.businessIdentityId || '').toLowerCase().includes(q)) return true;
            for (const p of g.profiles) {
              if (p.name.toLowerCase().includes(q)) return true;
              if (p.tenantIds.some((tid) => tid.toLowerCase().includes(q))) return true;
            }
            return false;
          }),
      }))
      .filter((b) => b.groups.length > 0 || (q.length === 0 && !hasPhones && !hasDuplicates));
  }, [buckets, platformFilter, hasPhones, hasDuplicates, unclassifiedOnly, search]);

  const totalGroups = filtered.reduce((acc, b) => acc + b.groups.length, 0);
  const totalProfiles = filtered.reduce(
    (acc, b) => acc + b.groups.reduce((g, w) => g + w.profileCount, 0),
    0,
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Workspaces</h1>
          <p className="text-sm text-gray-500">
            Customer workspaces grouped from raw tenants. Read-only.
            {' '}
            <Link to="/admin/legacy/tenants" className="text-gray-400 hover:underline">
              View raw tenants
            </Link>
          </p>
        </div>
        <button
          onClick={load}
          className="btn-secondary flex items-center gap-2"
          disabled={loading}
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-800 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Filters */}
      <div className="card p-4 space-y-3">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-gray-500">
          <Filter className="h-3 w-3" />
          Filters
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm text-gray-600 flex items-center gap-2">
            <span className="font-medium">Platform</span>
            <select
              className="input"
              value={platformFilter}
              onChange={(e) => setPlatformFilter(e.target.value as PlatformId | '')}
            >
              <option value="">All</option>
              {buckets.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>

          <ToggleChip
            label="Has phone numbers"
            on={hasPhones}
            onClick={() => setHasPhones((v) => !v)}
            icon={<Phone className="h-3 w-3" />}
          />
          <ToggleChip
            label="Has duplicates"
            on={hasDuplicates}
            onClick={() => setHasDuplicates((v) => !v)}
            icon={<Archive className="h-3 w-3" />}
          />
          <ToggleChip
            label="Unclassified only"
            on={unclassifiedOnly}
            onClick={() => setUnclassifiedOnly((v) => !v)}
            icon={<HelpCircle className="h-3 w-3" />}
          />

          <div className="ml-auto flex items-center gap-2 text-sm">
            <Search className="h-4 w-4 text-gray-400" />
            <input
              type="text"
              className="input"
              placeholder="Search workspace, profile, tenant id…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ minWidth: 280 }}
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="text-gray-400 hover:text-gray-700"
                title="Clear"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
        <div className="text-xs text-gray-400">
          Showing <span className="tabular-nums">{totalGroups}</span> workspace
          {totalGroups === 1 ? '' : 's'} ·{' '}
          <span className="tabular-nums">{totalProfiles}</span> profile
          {totalProfiles === 1 ? '' : 's'} across {filtered.length} platform
          {filtered.length === 1 ? '' : 's'}.
        </div>
      </div>

      {/* Tree by platform */}
      {loading && buckets.length === 0 ? (
        <div className="card p-8 text-center text-gray-400">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="card p-8 text-center text-gray-500">
          No workspaces match the current filters.
        </div>
      ) : (
        filtered.map((bucket) => (
          <PlatformBucketBlock key={bucket.id} bucket={bucket} />
        ))
      )}
    </div>
  );
}

function ToggleChip({
  label,
  on,
  onClick,
  icon,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
        on
          ? 'bg-primary-50 text-primary-700 border-primary-200'
          : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function PlatformBucketBlock({ bucket }: { bucket: PlatformBucket }) {
  const [open, setOpen] = useState(true);
  const isUnclassified = bucket.id === 'unclassified';

  return (
    <div className="card">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50"
      >
        <div className="flex items-center gap-2">
          {isUnclassified ? (
            <HelpCircle className="h-4 w-4 text-amber-500" />
          ) : (
            <Layers className="h-4 w-4 text-primary-500" />
          )}
          <span className="font-semibold text-gray-900">{bucket.name}</span>
          <PlatformBadge id={bucket.id} />
          <span className="text-xs text-gray-500 ml-2">
            <span className="tabular-nums">{bucket.groups.length}</span> workspace
            {bucket.groups.length === 1 ? '' : 's'}
            {' · '}
            <span className="tabular-nums">{bucket.summary.phoneNumberCount}</span> phone
            {bucket.summary.phoneNumberCount === 1 ? '' : 's'}
          </span>
        </div>
        {open ? (
          <ChevronUp className="h-4 w-4 text-gray-400" />
        ) : (
          <ChevronDown className="h-4 w-4 text-gray-400" />
        )}
      </button>

      {open && (
        <div className="border-t border-gray-200 divide-y divide-gray-100">
          {bucket.groups.length === 0 ? (
            <div className="px-4 py-4 text-sm text-gray-400">
              No workspaces in this platform.
            </div>
          ) : (
            bucket.groups.map((g, i) => (
              <WorkspaceRow key={`${g.source}-${g.businessIdentityId ?? g.name}-${i}`} group={g} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function WorkspaceRow({ group }: { group: WorkspaceGroup }) {
  const [open, setOpen] = useState(true);

  const sourceCls =
    group.source === 'business_identity'
      ? 'bg-blue-50 text-blue-700 border-blue-200'
      : group.source === 'name_prefix'
      ? 'bg-indigo-50 text-indigo-700 border-indigo-200'
      : 'bg-gray-100 text-gray-600 border-gray-200';
  const sourceLabel =
    group.source === 'business_identity'
      ? 'business identity'
      : group.source === 'name_prefix'
      ? 'name prefix'
      : 'standalone';

  return (
    <div className="px-4 py-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 hover:bg-gray-50 -mx-2 px-2 py-1 rounded text-left"
      >
        <Building2 className="h-4 w-4 text-gray-400 flex-shrink-0" />
        <span className="font-medium text-gray-900 truncate">{group.name}</span>
        <span className={`px-2 py-0.5 text-[10px] rounded-full font-mono border ${sourceCls}`}>
          {sourceLabel}
        </span>
        <span className="text-xs text-gray-500 ml-auto flex-shrink-0">
          <span className="tabular-nums">{group.profileCount}</span> profile
          {group.profileCount === 1 ? '' : 's'}
          {group.totalTenantCount !== group.profileCount && (
            <>
              {' '}
              <span className="text-amber-600">· {group.totalTenantCount} tenants</span>
            </>
          )}
          {group.totalPhoneNumbersCount > 0 && (
            <>
              {' '}
              · <Phone className="h-3 w-3 inline -mt-0.5" /> {group.totalPhoneNumbersCount}
            </>
          )}
        </span>
        {open ? (
          <ChevronUp className="h-4 w-4 text-gray-400 flex-shrink-0" />
        ) : (
          <ChevronDown className="h-4 w-4 text-gray-400 flex-shrink-0" />
        )}
      </button>

      {open && (
        <div className="mt-2 ml-7 space-y-1.5">
          {group.profiles.map((p, i) => (
            <ProfileItem key={`${p.name}-${i}`} profile={p} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProfileItem({ profile }: { profile: ProfileRow }) {
  const isDup = profile.duplicateCount > 1;
  return (
    <div className="flex items-center gap-3 text-sm py-1.5 px-2 rounded hover:bg-gray-50">
      <MapPin className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
      <span className="text-gray-900">{profile.name}</span>

      {isDup && (
        <span
          className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-amber-100 text-amber-700 border border-amber-200"
          title={`${profile.duplicateCount} tenant rows collapsed: ${profile.tenantIds.join(', ')}`}
        >
          ×{profile.duplicateCount} duplicates
        </span>
      )}

      <span className="ml-auto flex items-center gap-2 text-xs">
        {profile.hasCurrent && (
          <span
            className="inline-flex items-center gap-0.5 text-green-700"
            title="Has rows in tenant_phone_numbers"
          >
            <CheckCircle2 className="h-3 w-3" />
            <span className="tabular-nums">{profile.phoneNumbersCount}</span>
          </span>
        )}
        {profile.hasLegacy && (
          <span
            className="inline-flex items-center gap-0.5 text-amber-700"
            title="Has rows in phone_number_assignments (legacy)"
          >
            <Archive className="h-3 w-3" />
            legacy
          </span>
        )}
      </span>
    </div>
  );
}

function PlatformBadge({ id }: { id: PlatformId }) {
  const cls =
    id === 'unclassified'
      ? 'bg-amber-50 text-amber-700 border-amber-200'
      : 'bg-primary-50 text-primary-700 border-primary-200';
  return (
    <span className={`px-2 py-0.5 text-[10px] rounded-full font-mono border ${cls}`}>
      {id}
    </span>
  );
}
