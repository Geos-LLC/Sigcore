import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  MapPin,
  Phone,
  RefreshCw,
  AlertCircle,
  Filter,
  Search,
  X,
  ChevronRight,
  Share2,
  CheckCircle2,
} from 'lucide-react';
import { adminApi } from '../../services/adminApi';
import type { ProfileSummary, PlatformId, AdminListMeta } from '../../types';
import { IdChip } from '../../components/admin/IdChip';
import { SourceBadge } from '../../components/admin/SourceBadge';

const SOURCE_OPTIONS = [
  '',
  'leadbridge',
  'hirefunnel',
  'serviceflow',
  'callio',
  'thumbtack',
  'yelp',
  'facebook',
  'craigslist',
  'indeed',
  'manual',
  'internal',
];

const PLATFORM_OPTIONS: Array<{ value: '' | PlatformId; label: string }> = [
  { value: '', label: 'All' },
  { value: 'leadbridge', label: 'LeadBridge' },
  { value: 'hirefunnel', label: 'HireFunnel' },
  { value: 'serviceflow', label: 'ServiceFlow' },
  { value: 'callio', label: 'Callio' },
  { value: 'unclassified', label: 'Unclassified' },
];

export default function AdminProfilesPage() {
  const [rows, setRows] = useState<ProfileSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [platform, setPlatform] = useState<'' | PlatformId>('');
  const [source, setSource] = useState('');
  const [hasPhones, setHasPhones] = useState(false);
  const [hasShared, setHasShared] = useState(false);
  const [hasExternal, setHasExternal] = useState(false);
  const [defaultsOnly, setDefaultsOnly] = useState(false);
  // PR14 — single toggle for raw default profiles (kept + zombie defaults).
  // Off by default; backend filter excludes both classifications.
  const [showRawDefaults, setShowRawDefaults] = useState(false);
  const [includeZombies, setIncludeZombies] = useState(false);
  const [meta, setMeta] = useState<AdminListMeta | null>(null);
  const [search, setSearch] = useState('');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, meta } = await adminApi.getProfilesWithMeta({
        platformId: platform || undefined,
        source: source || undefined,
        hasPhones: hasPhones || undefined,
        hasSharedPhone: hasShared || undefined,
        hasExternalId: hasExternal || undefined,
        isDefault: defaultsOnly || undefined,
        showRawDefaults: showRawDefaults || undefined,
        includeZombies: includeZombies || undefined,
      });
      setRows(data);
      setMeta(meta);
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Failed to load profiles');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    platform,
    source,
    hasPhones,
    hasShared,
    hasExternal,
    defaultsOnly,
    showRawDefaults,
    includeZombies,
  ]);

  const filtered = useMemo(() => {
    // PR14: visibility (kept_default / zombie_default) is enforced server-side.
    // Client-side filter is now just the search box.
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      if (r.displayName.toLowerCase().includes(q)) return true;
      if (r.id.toLowerCase().includes(q)) return true;
      if ((r.businessName || '').toLowerCase().includes(q)) return true;
      if (r.communicationBusinessId.toLowerCase().includes(q)) return true;
      if (r.tenantId.toLowerCase().includes(q)) return true;
      if ((r.externalProfileId || '').toLowerCase().includes(q)) return true;
      return false;
    });
  }, [rows, search]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Profiles</h1>
          <p className="text-sm text-gray-500">
            Source-bound communication profiles. Read-only.
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
              value={platform}
              onChange={(e) => setPlatform((e.target.value || '') as PlatformId | '')}
            >
              {PLATFORM_OPTIONS.map((p) => (
                <option key={p.value || 'all'} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm text-gray-600 flex items-center gap-2">
            <span className="font-medium">Source</span>
            <select className="input" value={source} onChange={(e) => setSource(e.target.value)}>
              {SOURCE_OPTIONS.map((s) => (
                <option key={s || 'all'} value={s}>
                  {s || 'All'}
                </option>
              ))}
            </select>
          </label>
          <ToggleChip label="Has phones" on={hasPhones} onClick={() => setHasPhones((v) => !v)} icon={<Phone className="h-3 w-3" />} />
          <ToggleChip label="Has shared phone" on={hasShared} onClick={() => setHasShared((v) => !v)} icon={<Share2 className="h-3 w-3" />} />
          <ToggleChip label="Has external id" on={hasExternal} onClick={() => setHasExternal((v) => !v)} icon={<MapPin className="h-3 w-3" />} />
          <ToggleChip label="Default only" on={defaultsOnly} onClick={() => setDefaultsOnly((v) => !v)} icon={<CheckCircle2 className="h-3 w-3" />} />
          <button
            onClick={() => setShowRawDefaults((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
              showRawDefaults
                ? 'bg-amber-50 text-amber-700 border-amber-200'
                : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
            }`}
            title="Reveal kept Default profiles (slug='default', is_default=false). PR6 demoted these for back-compat."
          >
            <CheckCircle2 className="h-3 w-3" />
            Show kept defaults
            {meta && (meta.hiddenRawDefaults ?? 0) > 0 && !showRawDefaults && (
              <span className="ml-1 inline-flex items-center justify-center min-w-[1.25rem] h-4 px-1 rounded-full bg-amber-100 text-amber-700 text-[10px] font-mono">
                {meta.hiddenRawDefaults}
              </span>
            )}
          </button>
          <button
            onClick={() => setIncludeZombies((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
              includeZombies
                ? 'bg-amber-50 text-amber-700 border-amber-200'
                : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
            }`}
            title="Reveal zombie default profiles whose parent business has no PR6 metadata."
          >
            Show zombie profiles
            {meta && meta.hiddenZombies > 0 && !includeZombies && (
              <span className="ml-1 inline-flex items-center justify-center min-w-[1.25rem] h-4 px-1 rounded-full bg-amber-100 text-amber-700 text-[10px] font-mono">
                {meta.hiddenZombies}
              </span>
            )}
          </button>
          <div className="ml-auto flex items-center gap-2 text-sm">
            <Search className="h-4 w-4 text-gray-400" />
            <input
              type="text"
              className="input"
              placeholder="Search profile, business, tenant id…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ minWidth: 280 }}
            />
            {search && (
              <button onClick={() => setSearch('')} className="text-gray-400 hover:text-gray-700">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
        <div className="text-xs text-gray-400">
          Showing <span className="tabular-nums">{filtered.length}</span> of{' '}
          <span className="tabular-nums">{rows.length}</span> profiles.
        </div>
      </div>

      {/* Table */}
      <div className="card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="text-left px-4 py-3">Profile</th>
                <th className="text-left px-4 py-3">Source</th>
                <th className="text-left px-4 py-3">Business</th>
                <th className="text-left px-4 py-3">Default</th>
                <th className="text-left px-4 py-3">Phones</th>
                <th className="text-left px-4 py-3">External id</th>
                <th className="text-right px-4 py-3 w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {loading && filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-gray-400">
                    Loading…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                    No profiles match the current filters.
                  </td>
                </tr>
              ) : (
                filtered.map((p) => (
                  <tr key={p.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <Link
                        to={`/admin/profiles/${p.id}`}
                        className="font-medium text-gray-900 hover:text-primary-700"
                      >
                        {p.displayName}
                      </Link>
                      <div className="mt-0.5 flex items-center gap-2">
                        <IdChip label="profile" value={p.id} />
                        <span className="text-xs text-gray-400">slug: {p.slug}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <SourceBadge source={p.source} />
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        to={`/admin/businesses/${p.communicationBusinessId}`}
                        className="text-gray-700 hover:text-primary-700"
                      >
                        {p.businessName || '—'}
                      </Link>
                      <div className="mt-0.5">
                        <IdChip label="biz" value={p.communicationBusinessId} />
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {p.isDefault ? (
                        <span className="inline-flex items-center gap-0.5 text-green-700 text-xs">
                          <CheckCircle2 className="h-3 w-3" />
                          default
                        </span>
                      ) : p.slug === 'default' ? (
                        <span
                          className="inline-flex items-center text-[10px] text-gray-400 italic"
                          title="Kept for backward compatibility after LB profile materialization"
                        >
                          kept
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1 tabular-nums text-gray-700">
                        <Phone className="h-3 w-3 text-gray-400" />
                        {p.phoneCount}
                      </span>
                      {p.hasSharedPhone && (
                        <span className="ml-2 inline-flex items-center gap-0.5 text-[10px] text-amber-700">
                          <Share2 className="h-3 w-3" />
                          shared
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <IdChip value={p.externalProfileId} />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        to={`/admin/profiles/${p.id}`}
                        className="inline-flex items-center text-primary-600 hover:text-primary-800"
                      >
                        <ChevronRight className="h-4 w-4" />
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
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
