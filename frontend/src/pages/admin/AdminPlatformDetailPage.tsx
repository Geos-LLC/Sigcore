import { useEffect, useMemo, useState } from 'react';
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
  Building2,
  MapPin,
  Archive,
  CheckCircle2,
  ShoppingCart,
  ToggleLeft,
  ToggleRight,
} from 'lucide-react';
import { adminApi } from '../../services/adminApi';
import type {
  PlatformDetail,
  ProfileRow,
  WorkspaceGroup,
} from '../../types';
import ProvisionAndAssignPhoneNumberModal, {
  type ProvisionContextChoice,
} from '../../components/admin/ProvisionAndAssignPhoneNumberModal';

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
  const [provisionOpen, setProvisionOpen] = useState(false);
  const [webhookTogglingId, setWebhookTogglingId] = useState<string | null>(null);

  // PR16 — flatten (workspace × real profile) tuples across workspace groups so
  // the provision modal can target a tenant+profile pair. Profiles without a
  // backing communication_profile id (legacy derived rows) are skipped because
  // there is nothing for the backend to assign the phone to.
  const provisionChoices = useMemo<ProvisionContextChoice[]>(() => {
    if (!detail) return [];
    const out: ProvisionContextChoice[] = [];
    for (const wg of detail.workspaceGroups ?? []) {
      const wgTenantId = wg.tenantId ?? null;
      for (const p of wg.profiles) {
        if (!p.communicationProfileId) continue;
        const tenantId = wgTenantId ?? p.tenantIds[0];
        if (!tenantId) continue;
        out.push({
          key: `${tenantId}:${p.communicationProfileId}`,
          label:
            wg.profileCount > 1 || (detail.workspaceGroups ?? []).length > 1
              ? `${wg.name} › ${p.name}`
              : p.name,
          tenantId,
          profileId: p.communicationProfileId,
          workspaceLabel: wg.name,
          profileLabel: p.name,
        });
      }
    }
    return out;
  }, [detail]);

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

  const handleToggleWebhook = async (
    webhookId: string,
    currentStatus: string,
  ) => {
    if (webhookTogglingId) return;
    const next = currentStatus === 'active' ? 'inactive' : 'active';
    setWebhookTogglingId(webhookId);
    setError(null);
    try {
      await adminApi.setWebhookSubscriptionStatus(webhookId, next);
      setDetail((prev) =>
        prev
          ? {
              ...prev,
              webhooks: prev.webhooks.map((w) =>
                w.id === webhookId ? { ...w, status: next } : w,
              ),
            }
          : prev,
      );
    } catch (err: any) {
      setError(
        err.response?.data?.message ||
          err.message ||
          'Failed to update webhook subscription',
      );
    } finally {
      setWebhookTogglingId(null);
    }
  };

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
        <div className="flex items-center gap-2">
          <button
            onClick={() => setProvisionOpen(true)}
            className="btn btn-primary flex items-center gap-2"
            disabled={loading || provisionChoices.length === 0}
            title={
              provisionChoices.length === 0
                ? 'No assignable profiles in this platform'
                : 'Buy a Twilio number and assign it in one step'
            }
          >
            <ShoppingCart className="h-4 w-4" />
            Add Phone Number
          </button>
          <button
            onClick={load}
            className="btn-secondary flex items-center gap-2"
            disabled={loading}
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
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

      {/* Workspaces (grouped tree: Workspace → Profiles) */}
      <Collapsible
        title="Workspaces"
        icon={<Users className="h-4 w-4" />}
        count={detail?.workspaceGroups?.length ?? 0}
        open={expanded.workspaces}
        onToggle={() => toggle('workspaces')}
      >
        {detail && detail.workspaceGroups && detail.workspaceGroups.length > 0 ? (
          <div className="divide-y divide-gray-200">
            {detail.workspaceGroups.map((wg, idx) => (
              <WorkspaceGroupRow
                key={`${wg.source}-${wg.businessIdentityId ?? wg.name}-${idx}`}
                group={wg}
              />
            ))}
          </div>
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
          <div className="px-4 py-8 text-center">
            <div className="text-sm text-gray-700 font-medium">No phone numbers yet.</div>
            {detail?.id === 'hirefunnel' && (
              <div className="text-xs text-gray-500 mt-1">
                HireFunnel needs one sender number for SMS reminders.
              </div>
            )}
            <button
              onClick={() => setProvisionOpen(true)}
              className="btn btn-primary inline-flex items-center gap-2 mt-3"
              disabled={loading || provisionChoices.length === 0}
            >
              <ShoppingCart className="h-4 w-4" />
              {detail?.id === 'hirefunnel' ? 'Get Number' : 'Get & Assign Phone Number'}
            </button>
          </div>
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
                <th className="text-right px-4 py-2">Enabled</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {detail.webhooks.map((w) => {
                const isActive = w.status === 'active';
                const isToggling = webhookTogglingId === w.id;
                return (
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
                    <td className="px-4 py-2 text-right">
                      <button
                        onClick={() => handleToggleWebhook(w.id, w.status)}
                        disabled={isToggling}
                        title={isActive ? 'Disable webhook' : 'Enable webhook'}
                        className={`p-1 rounded hover:bg-gray-100 disabled:opacity-50 ${
                          isActive ? 'text-green-500' : 'text-gray-400'
                        }`}
                      >
                        {isActive ? (
                          <ToggleRight className="h-5 w-5" />
                        ) : (
                          <ToggleLeft className="h-5 w-5" />
                        )}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <Empty message="No webhook subscriptions for this platform." />
        )}
      </Collapsible>

      {detail && provisionChoices.length > 0 && (
        <ProvisionAndAssignPhoneNumberModal
          isOpen={provisionOpen}
          onClose={() => setProvisionOpen(false)}
          onSuccess={() => {
            setProvisionOpen(false);
            load();
          }}
          choices={provisionChoices}
          intro={
            detail.id === 'hirefunnel'
              ? 'HireFunnel needs one sender number for SMS reminders.'
              : undefined
          }
        />
      )}
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

/**
 * Renders one customer workspace (with N profiles inside). Source-coded:
 *   business_identity → blue (highest confidence — schema-linked)
 *   name_prefix       → indigo (heuristic match on tenants.name)
 *   standalone        → gray (1 tenant = 1 workspace = 1 profile)
 */
function WorkspaceGroupRow({ group }: { group: WorkspaceGroup }) {
  const [open, setOpen] = useState(true);

  const sourceCls =
    group.source === 'business_identity'
      ? 'bg-blue-50 text-blue-700 border border-blue-200'
      : group.source === 'name_prefix'
      ? 'bg-indigo-50 text-indigo-700 border border-indigo-200'
      : 'bg-gray-100 text-gray-600 border border-gray-200';

  const sourceLabel =
    group.source === 'business_identity'
      ? 'workspace'
      : group.source === 'name_prefix'
      ? 'name prefix'
      : 'standalone';

  return (
    <div className="px-4 py-3">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 hover:bg-gray-50 -mx-2 px-2 py-1 rounded"
      >
        <Building2 className="h-4 w-4 text-gray-400 flex-shrink-0" />
        <span className="font-medium text-gray-900 truncate">{group.name}</span>
        <span className={`px-2 py-0.5 text-[10px] rounded-full font-mono ${sourceCls}`}>
          {sourceLabel}
        </span>
        <span className="text-xs text-gray-500 ml-auto flex-shrink-0">
          <span className="tabular-nums">{group.profileCount}</span>{' '}
          profile{group.profileCount === 1 ? '' : 's'}
          {group.totalTenantCount !== group.profileCount && (
            <>
              {' '}
              <span className="text-amber-600">
                · {group.totalTenantCount} tenant rows
              </span>
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
        {profile.attributionReasons.length === 1 ? (
          <AttributionReasonBadge reason={profile.attributionReasons[0]} />
        ) : profile.attributionReasons.length > 1 ? (
          <span
            className="px-1.5 py-0.5 text-[10px] rounded bg-gray-100 text-gray-600 border border-gray-200"
            title={profile.attributionReasons.join(', ')}
          >
            {profile.attributionReasons.length} reasons
          </span>
        ) : null}
      </span>
    </div>
  );
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

/**
 * Renders the platform-attribution reason returned by the backend
 * (lexicon: 'anchor_name' | 'product_workspace:<type>' |
 *           'webhook_url:<host>' | 'api_key_name:<token>' | 'unclassified').
 *
 * Color encodes confidence — anchor (highest) is green, then product_workspace
 * (blue), webhook_url (indigo), api_key_name (amber), unclassified (gray).
 */
function AttributionReasonBadge({ reason }: { reason: string }) {
  if (!reason || reason === 'unclassified') {
    return (
      <span className="px-2 py-0.5 text-xs rounded-full bg-gray-100 text-gray-500" title="No signal matched">
        unclassified
      </span>
    );
  }

  const [head, tail] = reason.split(':', 2);
  const cls =
    head === 'anchor_name'
      ? 'bg-green-100 text-green-700 border border-green-200'
      : head === 'product_workspace'
      ? 'bg-blue-50 text-blue-700 border border-blue-200'
      : head === 'webhook_url'
      ? 'bg-indigo-50 text-indigo-700 border border-indigo-200'
      : head === 'api_key_name'
      ? 'bg-amber-50 text-amber-700 border border-amber-200'
      : 'bg-gray-100 text-gray-600';

  const label = tail ? `${head.replace(/_/g, ' ')}: ${tail}` : head.replace(/_/g, ' ');
  return (
    <span
      className={`px-2 py-0.5 text-xs rounded-full font-mono ${cls}`}
      title={`Attribution signal: ${reason}`}
    >
      {label}
    </span>
  );
}
