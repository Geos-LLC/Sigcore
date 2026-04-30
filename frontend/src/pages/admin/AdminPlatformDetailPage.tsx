import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Layers,
  Users,
  Phone,
  Key,
  Webhook,
  Activity,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  HelpCircle,
} from 'lucide-react';
import { adminApi } from '../../services/adminApi';
import type { PlatformDetail } from '../../types';

type Section = 'workspaces' | 'phoneNumbers' | 'apiKeys' | 'webhooks';

function fmt(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

export default function AdminPlatformDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<PlatformDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<Section, boolean>>({
    workspaces: true,
    phoneNumbers: true,
    apiKeys: false,
    webhooks: false,
  });

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setDetail(await adminApi.getPlatform(id));
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Failed to load platform');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const toggle = (s: Section) => setExpanded((e) => ({ ...e, [s]: !e[s] }));
  const isUnclassified = detail?.id === 'unclassified';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-start gap-3">
          <Link to="/admin/platforms" className="text-gray-400 hover:text-gray-700 mt-1">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <div className="flex items-center gap-2">
              {isUnclassified ? (
                <HelpCircle className="h-5 w-5 text-amber-500" />
              ) : (
                <Layers className="h-5 w-5 text-primary-500" />
              )}
              <h1 className="text-2xl font-bold text-gray-900">{detail?.name ?? id}</h1>
            </div>
            <p className="text-sm text-gray-500">
              {isUnclassified
                ? 'Tenants whose name does not match a known platform anchor.'
                : detail?.anchorTenantId
                ? `Anchor tenant: ${detail.anchorTenantId}`
                : 'No anchor tenant in this workspace.'}
            </p>
          </div>
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
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat
          label="Workspaces"
          value={detail?.workspaceCount}
          icon={<Users className="h-4 w-4" />}
        />
        <Stat
          label="Phone numbers"
          value={detail?.phoneNumberCount}
          icon={<Phone className="h-4 w-4" />}
        />
        <Stat label="API keys" value={detail?.apiKeyCount} icon={<Key className="h-4 w-4" />} />
        <Stat
          label="Webhooks"
          value={detail?.webhookSubscriptionCount}
          icon={<Webhook className="h-4 w-4" />}
        />
        <Stat
          label="Last activity"
          value={fmt(detail?.lastActivityAt ?? null)}
          icon={<Activity className="h-4 w-4" />}
        />
      </div>

      {/* Workspaces */}
      <Collapsible
        title="Workspaces"
        icon={<Users className="h-4 w-4" />}
        count={detail?.workspaces.length ?? 0}
        open={expanded.workspaces}
        onToggle={() => toggle('workspaces')}
      >
        {detail && detail.workspaces.length > 0 ? (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="text-left px-4 py-2">Name</th>
                <th className="text-left px-4 py-2">Status</th>
                <th className="text-left px-4 py-2">Created</th>
                <th className="text-left px-4 py-2">ID</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {detail.workspaces.map((w) => (
                <tr key={w.id}>
                  <td className="px-4 py-2 font-medium text-gray-900">{w.name}</td>
                  <td className="px-4 py-2">
                    <StatusBadge value={w.status} />
                  </td>
                  <td className="px-4 py-2 text-gray-500">
                    {new Date(w.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-400">{w.id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty message="No workspaces attributed to this platform." />
        )}
      </Collapsible>

      {/* Phone numbers */}
      <Collapsible
        title="Phone numbers"
        icon={<Phone className="h-4 w-4" />}
        count={detail?.phoneNumbers.length ?? 0}
        open={expanded.phoneNumbers}
        onToggle={() => toggle('phoneNumbers')}
      >
        {detail && detail.phoneNumbers.length > 0 ? (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="text-left px-4 py-2">Number</th>
                <th className="text-left px-4 py-2">Provider</th>
                <th className="text-left px-4 py-2">A2P</th>
                <th className="text-left px-4 py-2">Tenant</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {detail.phoneNumbers.map((p) => (
                <tr key={p.id}>
                  <td className="px-4 py-2 font-mono">{p.phoneNumber}</td>
                  <td className="px-4 py-2 text-gray-700">{p.provider}</td>
                  <td className="px-4 py-2 text-gray-500">{p.a2pStatus ?? '—'}</td>
                  <td className="px-4 py-2 text-gray-700">{p.tenantName ?? p.tenantId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty message="No phone numbers in tenant_phone_numbers for this platform." />
        )}
      </Collapsible>

      {/* API keys */}
      <Collapsible
        title="API keys"
        icon={<Key className="h-4 w-4" />}
        count={detail?.apiKeys.length ?? 0}
        open={expanded.apiKeys}
        onToggle={() => toggle('apiKeys')}
      >
        {detail && detail.apiKeys.length > 0 ? (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="text-left px-4 py-2">Name</th>
                <th className="text-left px-4 py-2">Scope</th>
                <th className="text-left px-4 py-2">Tenant</th>
                <th className="text-left px-4 py-2">Last used</th>
                <th className="text-left px-4 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {detail.apiKeys.map((k) => (
                <tr key={k.id}>
                  <td className="px-4 py-2 font-medium text-gray-900">{k.name}</td>
                  <td className="px-4 py-2">
                    <span className="px-2 py-0.5 text-xs rounded-full bg-blue-50 text-blue-600">
                      {k.scope}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-gray-700">{k.tenantName ?? '—'}</td>
                  <td className="px-4 py-2 text-gray-500">{fmt(k.lastUsedAt)}</td>
                  <td className="px-4 py-2">
                    <StatusBadge value={k.active ? 'active' : 'inactive'} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty message="No API keys for this platform." />
        )}
      </Collapsible>

      {/* Webhooks */}
      <Collapsible
        title="Webhook subscriptions"
        icon={<Webhook className="h-4 w-4" />}
        count={detail?.webhooks.length ?? 0}
        open={expanded.webhooks}
        onToggle={() => toggle('webhooks')}
      >
        {detail && detail.webhooks.length > 0 ? (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="text-left px-4 py-2">Name</th>
                <th className="text-left px-4 py-2">URL</th>
                <th className="text-left px-4 py-2">Events</th>
                <th className="text-left px-4 py-2">Tenant</th>
                <th className="text-left px-4 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {detail.webhooks.map((w) => (
                <tr key={w.id}>
                  <td className="px-4 py-2 font-medium text-gray-900">{w.name}</td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-600 break-all">
                    {w.webhookUrl}
                  </td>
                  <td className="px-4 py-2 text-gray-500 text-xs">
                    {w.events.length} event{w.events.length === 1 ? '' : 's'}
                  </td>
                  <td className="px-4 py-2 text-gray-700">{w.tenantName ?? '—'}</td>
                  <td className="px-4 py-2">
                    <StatusBadge value={w.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty message="No webhook subscriptions for this platform." />
        )}
      </Collapsible>
    </div>
  );
}

function Stat({
  label,
  value,
  icon,
}: {
  label: string;
  value: number | string | undefined;
  icon: React.ReactNode;
}) {
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-gray-500">{label}</span>
        <span className="text-gray-300">{icon}</span>
      </div>
      <div className="mt-2 text-xl font-semibold text-gray-900 tabular-nums">
        {value === undefined ? '—' : value}
      </div>
    </div>
  );
}

function Collapsible({
  title,
  icon,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="card">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50"
      >
        <div className="flex items-center gap-2">
          <span className="text-gray-400">{icon}</span>
          <span className="font-medium text-gray-900">{title}</span>
          <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full tabular-nums">
            {count}
          </span>
        </div>
        {open ? (
          <ChevronUp className="h-4 w-4 text-gray-400" />
        ) : (
          <ChevronDown className="h-4 w-4 text-gray-400" />
        )}
      </button>
      {open && <div className="border-t border-gray-200 overflow-x-auto">{children}</div>}
    </div>
  );
}

function Empty({ message }: { message: string }) {
  return <div className="px-4 py-6 text-center text-sm text-gray-400">{message}</div>;
}

function StatusBadge({ value }: { value: string }) {
  const v = value.toLowerCase();
  const cls =
    v === 'active'
      ? 'bg-green-100 text-green-700'
      : v === 'inactive' || v === 'paused'
      ? 'bg-gray-100 text-gray-500'
      : v === 'suspended' || v === 'error'
      ? 'bg-red-100 text-red-700'
      : 'bg-blue-50 text-blue-600';
  return (
    <span className={`px-2 py-0.5 text-xs rounded-full ${cls}`}>{value}</span>
  );
}
