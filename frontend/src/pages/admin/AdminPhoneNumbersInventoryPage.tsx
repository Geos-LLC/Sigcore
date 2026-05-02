import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Phone,
  RefreshCw,
  AlertCircle,
  AlertTriangle,
  X,
  ChevronRight,
} from 'lucide-react';
import { adminApi } from '../../services/adminApi';
import type {
  InventoryRow,
  InventoryAssignmentChainEntry,
  PhoneModelBadge,
} from '../../types';
import { SourceBadge } from '../../components/admin/SourceBadge';

const MODEL_OPTIONS: Array<{ id: '' | PhoneModelBadge; label: string }> = [
  { id: '', label: 'All models' },
  { id: 'CURRENT', label: 'CURRENT only' },
  { id: 'LEGACY', label: 'LEGACY only' },
  { id: 'BOTH', label: 'BOTH (duplicates)' },
];

const PROVIDER_OPTIONS: Array<{ id: ''; label: string } | { id: string; label: string }> = [
  { id: '', label: 'All providers' },
  { id: 'twilio', label: 'twilio' },
  { id: 'openphone', label: 'openphone' },
  { id: 'whatsapp', label: 'whatsapp' },
];

function ModelBadge({ value }: { value: PhoneModelBadge }) {
  const cls =
    value === 'BOTH'
      ? 'bg-red-100 text-red-700 border border-red-200'
      : value === 'LEGACY'
      ? 'bg-amber-100 text-amber-700 border border-amber-200'
      : 'bg-green-100 text-green-700 border border-green-200';
  return (
    <span
      className={`inline-block px-2 py-0.5 text-xs font-semibold rounded-full ${cls}`}
      title={
        value === 'BOTH'
          ? 'Number exists in BOTH tenant_phone_numbers AND phone_number_assignments — needs migration'
          : value === 'LEGACY'
          ? 'Number only in phone_number_assignments (legacy table)'
          : 'Number only in tenant_phone_numbers (current model)'
      }
    >
      {value}
    </span>
  );
}

export default function AdminPhoneNumbersInventoryPage() {
  const [rows, setRows] = useState<InventoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<'' | PhoneModelBadge>('');
  const [provider, setProvider] = useState<string>('');
  const [selected, setSelected] = useState<InventoryRow | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await adminApi.getPhoneNumberInventory({
        model: model || undefined,
        provider: provider || undefined,
      });
      setRows(data);
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Failed to load inventory');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, provider]);

  const counts = useMemo(() => {
    const c: Record<PhoneModelBadge, number> = { BOTH: 0, LEGACY: 0, CURRENT: 0 };
    for (const r of rows) c[r.model] = (c[r.model] ?? 0) + 1;
    return c;
  }, [rows]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Phone Numbers</h1>
          <p className="text-sm text-gray-500">
            Unified view of <code className="font-mono">tenant_phone_numbers</code> and{' '}
            <code className="font-mono">phone_number_assignments</code>. Read-only.
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

      {/* Counts */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <CountCard label="Both" count={counts.BOTH} model="BOTH" />
        <CountCard label="Legacy only" count={counts.LEGACY} model="LEGACY" />
        <CountCard label="Current only" count={counts.CURRENT} model="CURRENT" />
      </div>

      {/* Filters */}
      <div className="card p-4 flex flex-wrap items-center gap-3">
        <label className="text-sm text-gray-600 flex items-center gap-2">
          <span className="font-medium">Model</span>
          <select
            className="input"
            value={model}
            onChange={(e) => setModel((e.target.value || '') as '' | PhoneModelBadge)}
          >
            {MODEL_OPTIONS.map((o) => (
              <option key={o.id || 'all'} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-gray-600 flex items-center gap-2">
          <span className="font-medium">Provider</span>
          <select
            className="input"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            {PROVIDER_OPTIONS.map((o) => (
              <option key={o.id || 'all'} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <span className="text-xs text-gray-400 ml-auto">
          Showing <span className="tabular-nums">{rows.length}</span> row
          {rows.length === 1 ? '' : 's'}
        </span>
      </div>

      {/* Table */}
      <div className="card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="text-left px-4 py-3">Number</th>
                <th className="text-left px-4 py-3">Model</th>
                <th className="text-left px-4 py-3">Assigned to</th>
                <th className="text-left px-4 py-3">Provider</th>
                <th className="text-left px-4 py-3">A2P</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {loading && rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                    No phone numbers match the current filters.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr
                    key={`${r.number}-${r.current?.id ?? ''}-${r.legacy?.id ?? ''}`}
                    className="cursor-pointer hover:bg-gray-50"
                    onClick={() => setSelected(r)}
                  >
                    <td className="px-4 py-3 font-mono align-top">{r.number}</td>
                    <td className="px-4 py-3 align-top">
                      <ModelBadge value={r.model} />
                    </td>
                    <td className="px-4 py-3 align-top">
                      <ChainCell chain={r.chain} fallbackTenantName={r.current?.tenantName ?? null} />
                    </td>
                    <td className="px-4 py-3 text-gray-700 align-top">{r.provider ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-500 align-top">{r.a2pStatus ?? '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selected && <DetailDrawer row={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

/**
 * Renders the assignment chain Platform → Workspace → Business → Profile (PR8).
 * One block per chain entry; multiple entries when the phone is shared.
 */
function ChainCell({
  chain,
  fallbackTenantName,
}: {
  chain: InventoryAssignmentChainEntry[];
  fallbackTenantName: string | null;
}) {
  if (chain.length === 0) {
    return (
      <span className="text-xs text-gray-400 italic">
        {fallbackTenantName
          ? `No active profile (legacy: ${fallbackTenantName})`
          : 'Unassigned'}
      </span>
    );
  }
  return (
    <div className="space-y-1.5">
      {chain.map((c, idx) => (
        <ChainRow key={`${c.profileId ?? 'na'}-${idx}`} entry={c} />
      ))}
    </div>
  );
}

function ChainRow({ entry }: { entry: InventoryAssignmentChainEntry }) {
  return (
    <div className="flex items-center gap-1.5 text-xs leading-tight whitespace-nowrap">
      <span className="text-gray-400 uppercase tracking-wider">{entry.platformId}</span>
      <ChevronRight className="h-3 w-3 text-gray-300" />
      <Link
        to={`/admin/businesses?workspaceKey=${encodeURIComponent(entry.workspaceKey)}`}
        className="text-gray-700 hover:text-primary-700"
      >
        {entry.workspaceDisplayName}
      </Link>
      {entry.businessId && (
        <>
          <ChevronRight className="h-3 w-3 text-gray-300" />
          <Link
            to={`/admin/businesses/${entry.businessId}`}
            className="text-gray-700 hover:text-primary-700"
          >
            {entry.businessDisplayName ?? entry.businessId.slice(0, 8)}
          </Link>
        </>
      )}
      {entry.profileId && (
        <>
          <ChevronRight className="h-3 w-3 text-gray-300" />
          <Link
            to={`/admin/profiles/${entry.profileId}`}
            className="font-medium text-gray-900 hover:text-primary-700"
          >
            {entry.profileDisplayName ?? entry.profileId.slice(0, 8)}
          </Link>
          {entry.profileSource && (
            <SourceBadge source={entry.profileSource} size="sm" />
          )}
          {entry.isDefault && (
            <span
              className="ml-1 inline-block px-1.5 py-0.5 rounded-full text-[9px] uppercase tracking-wider bg-green-50 text-green-700 border border-green-200"
              title="Default phone for this profile"
            >
              default
            </span>
          )}
        </>
      )}
    </div>
  );
}

function CountCard({
  label,
  count,
  model,
}: {
  label: string;
  count: number;
  model: PhoneModelBadge;
}) {
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-gray-500">{label}</span>
        <ModelBadge value={model} />
      </div>
      <div className="mt-2 text-2xl font-semibold text-gray-900 tabular-nums">{count}</div>
    </div>
  );
}

function DetailDrawer({
  row,
  onClose,
}: {
  row: InventoryRow;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40 flex" onClick={onClose}>
      <div className="flex-1 bg-black/30" />
      <aside
        className="w-full max-w-md bg-white shadow-2xl border-l border-gray-200 overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Phone className="h-4 w-4 text-gray-400" />
            <span className="font-mono text-sm">{row.number}</span>
            <ModelBadge value={row.model} />
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700">
            <X className="h-5 w-5" />
          </button>
        </div>

        {row.model === 'BOTH' && (
          <div className="m-5 p-3 bg-red-50 border border-red-200 rounded-lg flex items-start gap-2 text-sm text-red-800">
            <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <div>
              This number exists in both <code className="font-mono">tenant_phone_numbers</code>{' '}
              (current) and <code className="font-mono">phone_number_assignments</code> (legacy).
              Outbound traffic via <code className="font-mono">/api/internal/messages/send</code>{' '}
              will use the legacy row; outbound traffic via{' '}
              <code className="font-mono">/api/v1/messages</code> will use the current row.
            </div>
          </div>
        )}

        <div className="px-5 py-4 space-y-2">
          <div className="text-xs uppercase tracking-wide text-gray-500">Provider</div>
          <KV k="Provider" v={row.provider ?? '—'} />
          <KV k="A2P status" v={row.a2pStatus ?? '—'} />
        </div>

        <SectionTitle title="Current — tenant_phone_numbers" />
        {row.current ? (
          <div className="px-5 py-4 space-y-2">
            <KV k="Row id" v={row.current.id} mono />
            <KV k="Tenant" v={row.current.tenantName ?? row.current.tenantId} />
            <KV k="Tenant id" v={row.current.tenantId} mono />
            <KV k="Workspace id" v={row.current.workspaceId} mono />
            <KV k="Status" v={row.current.status} />
          </div>
        ) : (
          <div className="px-5 py-4 text-sm text-gray-400">
            Not present in <code className="font-mono">tenant_phone_numbers</code>.
          </div>
        )}

        <SectionTitle title="Legacy — phone_number_assignments" />
        {row.legacy ? (
          <div className="px-5 py-4 space-y-2">
            <KV k="Row id" v={row.legacy.id} mono />
            <KV k="business_id" v={row.legacy.businessId} mono />
            <KV k="business_id resolution" v={row.legacy.businessIdResolution} />
            <KV k="Type" v={row.legacy.type} />
            <KV k="Active" v={String(row.legacy.active)} />
          </div>
        ) : (
          <div className="px-5 py-4 text-sm text-gray-400">
            Not present in <code className="font-mono">phone_number_assignments</code>.
          </div>
        )}
      </aside>
    </div>
  );
}

function SectionTitle({ title }: { title: string }) {
  return (
    <div className="px-5 py-2 bg-gray-50 border-y border-gray-200 text-xs font-medium uppercase tracking-wide text-gray-500">
      {title}
    </div>
  );
}

function KV({ k, v, mono = false }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-3 text-sm">
      <span className="text-gray-500 w-32 flex-shrink-0">{k}</span>
      <span className={mono ? 'font-mono text-xs break-all' : 'text-gray-900'}>{v}</span>
    </div>
  );
}
