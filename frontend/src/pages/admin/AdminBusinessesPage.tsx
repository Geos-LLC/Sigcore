import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Building2,
  Phone,
  RefreshCw,
  AlertCircle,
  Filter,
  Search,
  X,
  ChevronRight,
  Layers,
  Share2,
} from 'lucide-react';
import { adminApi } from '../../services/adminApi';
import type { BusinessSummary, PlatformId, AdminListMeta } from '../../types';
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

export default function AdminBusinessesPage() {
  const [rows, setRows] = useState<BusinessSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [searchParams, setSearchParams] = useSearchParams();
  const workspaceKey = searchParams.get('workspaceKey') ?? '';

  const [platform, setPlatform] = useState<'' | PlatformId>('');
  const [source, setSource] = useState('');
  const [hasPhones, setHasPhones] = useState(false);
  const [hasShared, setHasShared] = useState(false);
  const [hasExternal, setHasExternal] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [meta, setMeta] = useState<AdminListMeta | null>(null);
  const [search, setSearch] = useState('');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, meta } = await adminApi.getBusinessesWithMeta({
        platformId: platform || undefined,
        source: source || undefined,
        hasPhones: hasPhones || undefined,
        hasSharedPhone: hasShared || undefined,
        hasExternalId: hasExternal || undefined,
        workspaceKey: workspaceKey || undefined,
        includeZombies: showRaw || undefined,
      });
      setRows(data);
      setMeta(meta);
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Failed to load businesses');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, source, hasPhones, hasShared, hasExternal, workspaceKey, showRaw]);

  const clearWorkspaceFilter = () => {
    const next = new URLSearchParams(searchParams);
    next.delete('workspaceKey');
    setSearchParams(next);
  };
  const workspaceLabel = useMemo(() => {
    if (!workspaceKey) return null;
    const first = rows.find((r) => r.workspaceKey === workspaceKey);
    return first?.workspaceDisplayName ?? workspaceKey;
  }, [rows, workspaceKey]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      if (r.displayName.toLowerCase().includes(q)) return true;
      if (r.id.toLowerCase().includes(q)) return true;
      if (r.tenantId.toLowerCase().includes(q)) return true;
      if ((r.tenantName || '').toLowerCase().includes(q)) return true;
      if ((r.externalBusinessId || '').toLowerCase().includes(q)) return true;
      return false;
    });
  }, [rows, search]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Businesses</h1>
          <p className="text-sm text-gray-500">
            Customer business / location rows. Drill down to a single business for its profiles &amp; phones.
          </p>
          {workspaceKey && (
            <div className="mt-2 inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary-50 text-primary-700 border border-primary-200 text-xs">
              <span className="text-gray-500">Workspace:</span>
              <Link
                to="/admin/workspaces"
                className="font-semibold hover:underline"
              >
                {workspaceLabel ?? workspaceKey}
              </Link>
              <button
                onClick={clearWorkspaceFilter}
                className="text-primary-700 hover:text-primary-900"
                title="Clear workspace filter"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
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
            <select
              className="input"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            >
              {SOURCE_OPTIONS.map((s) => (
                <option key={s || 'all'} value={s}>
                  {s || 'All'}
                </option>
              ))}
            </select>
          </label>
          <ToggleChip label="Has phones" on={hasPhones} onClick={() => setHasPhones((v) => !v)} icon={<Phone className="h-3 w-3" />} />
          <ToggleChip label="Has shared phone" on={hasShared} onClick={() => setHasShared((v) => !v)} icon={<Share2 className="h-3 w-3" />} />
          <ToggleChip label="Has external id" on={hasExternal} onClick={() => setHasExternal((v) => !v)} icon={<Layers className="h-3 w-3" />} />
          <button
            onClick={() => setShowRaw((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
              showRaw
                ? 'bg-amber-50 text-amber-700 border-amber-200'
                : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
            }`}
            title="Reveal zombie business rows (no PR6 metadata, no external id, not a known non-LB platform)."
          >
            Show raw / zombies
            {meta && meta.hiddenZombies > 0 && !showRaw && (
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
              placeholder="Search name, id, tenant…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ minWidth: 240 }}
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
          <span className="tabular-nums">{rows.length}</span> businesses.
        </div>
      </div>

      {/* Table */}
      <div className="card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="text-left px-4 py-3">Business / Location</th>
                <th className="text-left px-4 py-3">Workspace</th>
                <th className="text-left px-4 py-3">Platform</th>
                <th className="text-left px-4 py-3">Sources</th>
                <th className="text-left px-4 py-3">Profiles</th>
                <th className="text-left px-4 py-3">Phones</th>
                <th className="text-left px-4 py-3">External id</th>
                <th className="text-right px-4 py-3 w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {loading && filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-gray-400">
                    Loading…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                    No businesses match the current filters.
                  </td>
                </tr>
              ) : (
                filtered.map((b) => (
                  <tr key={b.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <Building2 className="h-4 w-4 text-gray-400 flex-shrink-0" />
                        <Link
                          to={`/admin/businesses/${b.id}`}
                          className="font-medium text-gray-900 hover:text-primary-700"
                        >
                          {b.displayName}
                        </Link>
                      </div>
                      <div className="mt-0.5">
                        <IdChip label="biz" value={b.id} />
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        to={`/admin/businesses?workspaceKey=${encodeURIComponent(b.workspaceKey)}`}
                        className="text-gray-700 hover:text-primary-700"
                      >
                        {b.workspaceDisplayName}
                      </Link>
                      <div className="mt-0.5">
                        <IdChip label="tenant" value={b.tenantId} />
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs font-mono text-gray-600">{b.platformId}</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {b.sources.map((s) => (
                          <SourceBadge key={s} source={s} />
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-gray-700">
                      {b.profileCount}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1 tabular-nums text-gray-700">
                        <Phone className="h-3 w-3 text-gray-400" />
                        {b.phoneCount}
                      </span>
                      {b.hasSharedPhone && (
                        <span
                          className="ml-2 inline-flex items-center gap-0.5 text-[10px] text-amber-700"
                          title="Shares ≥1 phone with another profile"
                        >
                          <Share2 className="h-3 w-3" />
                          shared
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {b.externalBusinessId ? (
                        <IdChip value={b.externalBusinessId} />
                      ) : (
                        <span className="text-xs text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        to={`/admin/businesses/${b.id}`}
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
