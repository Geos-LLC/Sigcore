/**
 * Admin Workspaces page (PR8 redesign).
 *
 * Hierarchy: Platform → **Workspace (customer/account)** → Business → Profile → Phone
 *
 * One row per *customer*. LeadBridge tenants collapse on
 * `metadata.lb_user_id` (PR6) so "Spotless Homes Tampa", "...Jacksonville",
 * etc. all show under a single "Spotless Homes" row. Non-LB tenants get
 * one row per tenant. Drill-down lands on the Businesses page filtered to
 * that workspace.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Building2,
  RefreshCw,
  AlertCircle,
  Filter,
  Search,
  X,
  ChevronRight,
  Phone,
  MapPin,
  EyeOff,
} from 'lucide-react';
import { adminApi } from '../../services/adminApi';
import type { WorkspaceSummary, PlatformId } from '../../types';

const PLATFORM_OPTIONS: Array<{ value: '' | PlatformId; label: string }> = [
  { value: '', label: 'All' },
  { value: 'leadbridge', label: 'LeadBridge' },
  { value: 'hirefunnel', label: 'HireFunnel' },
  { value: 'serviceflow', label: 'ServiceFlow' },
  { value: 'callio', label: 'Callio' },
  { value: 'unclassified', label: 'Unclassified' },
];

const PLATFORM_LABELS: Record<string, string> = {
  leadbridge: 'LeadBridge',
  hirefunnel: 'HireFunnel',
  serviceflow: 'ServiceFlow',
  callio: 'Callio',
  unclassified: 'Unclassified',
};

const PLATFORM_COLORS: Record<string, string> = {
  leadbridge: 'bg-orange-50 text-orange-700 border-orange-200',
  hirefunnel: 'bg-purple-50 text-purple-700 border-purple-200',
  serviceflow: 'bg-cyan-50 text-cyan-700 border-cyan-200',
  callio: 'bg-pink-50 text-pink-700 border-pink-200',
  unclassified: 'bg-gray-100 text-gray-500 border-gray-200',
};

export default function AdminWorkspacesPage() {
  const [rows, setRows] = useState<WorkspaceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [platform, setPlatform] = useState<'' | PlatformId>('');
  const [hideUnnamed, setHideUnnamed] = useState(true);
  const [search, setSearch] = useState('');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await adminApi.getWorkspaces({
        platformId: platform || undefined,
        hideUnnamedTenants: hideUnnamed || undefined,
      });
      setRows(data);
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Failed to load workspaces');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, hideUnnamed]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      if (r.displayName.toLowerCase().includes(q)) return true;
      if (r.key.toLowerCase().includes(q)) return true;
      if ((r.lbUserId ?? '').toLowerCase().includes(q)) return true;
      if (r.tenantIds.some((id) => id.toLowerCase().includes(q))) return true;
      return false;
    });
  }, [rows, search]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Workspaces</h1>
          <p className="text-sm text-gray-500">
            One row per customer / account. Multi-location LeadBridge customers collapse onto a single row.
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
                <option key={p.value || 'all'} value={p.value}>{p.label}</option>
              ))}
            </select>
          </label>
          <button
            onClick={() => setHideUnnamed((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
              hideUnnamed
                ? 'bg-primary-50 text-primary-700 border-primary-200'
                : 'bg-white text-gray-500 border-gray-200 hover:border-gray-300'
            }`}
            title='Hide tenants whose name still looks like the auto-generated "Account &lt;uuid&gt;" stub'
          >
            <EyeOff className="h-3 w-3" />
            Hide unnamed tenants
          </button>
          <div className="ml-auto flex items-center gap-2 text-sm">
            <Search className="h-4 w-4 text-gray-400" />
            <input
              type="text"
              className="input"
              placeholder="Search workspace, lb user id, tenant id…"
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
          <span className="tabular-nums">{rows.length}</span> workspaces.
        </div>
      </div>

      {/* Table */}
      <div className="card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="text-left px-4 py-3">Workspace</th>
                <th className="text-left px-4 py-3">Platform</th>
                <th className="text-left px-4 py-3">Businesses</th>
                <th className="text-left px-4 py-3">Profiles</th>
                <th className="text-left px-4 py-3">Phones</th>
                <th className="text-left px-4 py-3">Tenants</th>
                <th className="text-right px-4 py-3 w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {loading && filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-gray-400">Loading…</td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-gray-500">No workspaces match the current filters.</td>
                </tr>
              ) : (
                filtered.map((w) => (
                  <tr key={w.key} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <Link
                        to={`/admin/businesses?workspaceKey=${encodeURIComponent(w.key)}`}
                        className="font-medium text-gray-900 hover:text-primary-700 flex items-center gap-1.5"
                      >
                        <Building2 className="h-4 w-4 text-gray-400" />
                        {w.displayName}
                      </Link>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-400">
                        <span className="font-mono">{w.key}</span>
                        {w.kind === 'lb_customer' && w.lbUserId && (
                          <span className="text-[10px] uppercase tracking-wider text-gray-500">
                            lb user
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold tracking-wide ${
                          PLATFORM_COLORS[w.platformId] ?? PLATFORM_COLORS.unclassified
                        }`}
                      >
                        {PLATFORM_LABELS[w.platformId] ?? w.platformId}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        to={`/admin/businesses?workspaceKey=${encodeURIComponent(w.key)}`}
                        className="inline-flex items-center gap-1 tabular-nums text-gray-700 hover:text-primary-700"
                      >
                        <Building2 className="h-3 w-3 text-gray-400" />
                        {w.businessCount}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1 tabular-nums text-gray-700">
                        <MapPin className="h-3 w-3 text-gray-400" />
                        {w.profileCount}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1 tabular-nums text-gray-700">
                        <Phone className="h-3 w-3 text-gray-400" />
                        {w.phoneCount}
                      </span>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-gray-500">
                      {w.tenantIds.length}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        to={`/admin/businesses?workspaceKey=${encodeURIComponent(w.key)}`}
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
