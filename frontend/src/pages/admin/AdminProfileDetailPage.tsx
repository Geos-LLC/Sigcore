import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  MapPin,
  Phone,
  Plus,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Share2,
  ShoppingCart,
  MessageSquare,
  Building2,
} from 'lucide-react';
import { adminApi } from '../../services/adminApi';
import type { ProfileDetail } from '../../types';
import { IdChip } from '../../components/admin/IdChip';
import { SourceBadge } from '../../components/admin/SourceBadge';
import AssignPhoneNumberModal from '../../components/admin/AssignPhoneNumberModal';
import ProvisionAndAssignPhoneNumberModal from '../../components/admin/ProvisionAndAssignPhoneNumberModal';

function fmt(iso: string): string {
  return new Date(iso).toLocaleString();
}

export default function AdminProfileDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<ProfileDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [provisionOpen, setProvisionOpen] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setDetail(await adminApi.getProfile(id));
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Failed to load profile');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-start gap-3">
          <Link to="/admin/profiles" className="text-gray-400 hover:text-gray-700 mt-1">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <MapPin className="h-5 w-5 text-gray-400" />
              <h1 className="text-2xl font-bold text-gray-900">{detail?.displayName ?? id}</h1>
              {detail && <SourceBadge source={detail.source} />}
              {detail?.isDefault && (
                <span className="inline-flex items-center gap-0.5 text-green-700 text-xs px-2 py-0.5 bg-green-50 rounded-full border border-green-200">
                  <CheckCircle2 className="h-3 w-3" />
                  default
                </span>
              )}
            </div>
            <div className="text-sm text-gray-500 mt-1 flex items-center gap-4 flex-wrap">
              <IdChip label="profile id" value={detail?.id} />
              <IdChip label="business" value={detail?.communicationBusinessId} />
              <IdChip label="tenant" value={detail?.tenantId} />
              <IdChip label="external" value={detail?.externalProfileId ?? null} />
              <span className="text-xs text-gray-500">
                Platform: <span className="font-mono">{detail?.platformId}</span>
              </span>
            </div>
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

      {/* Breadcrumb to business */}
      {detail && (
        <div className="card p-4 flex items-center gap-3 text-sm">
          <Building2 className="h-4 w-4 text-gray-400" />
          <span className="text-gray-500">Business:</span>
          <Link
            to={`/admin/businesses/${detail.communicationBusinessId}`}
            className="font-medium text-gray-900 hover:text-primary-700"
          >
            {detail.businessName || detail.communicationBusinessId}
          </Link>
          <span className="text-gray-400 ml-auto">slug: {detail.slug}</span>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Phones" value={detail?.phoneCount} icon={<Phone className="h-4 w-4" />} />
        <Stat label="Status" value={detail?.status} icon={<CheckCircle2 className="h-4 w-4" />} />
        <Stat label="Source" value={detail?.source} icon={<MapPin className="h-4 w-4" />} />
        <Stat label="Recent msgs" value={detail?.recentMessages.length} icon={<MessageSquare className="h-4 w-4" />} />
      </div>

      {/* Phone assignments */}
      <div className="card">
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
          <div className="font-medium text-gray-900 flex items-center gap-2">
            <Phone className="h-4 w-4 text-gray-400" />
            Phone assignments
            <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full tabular-nums">
              {detail?.assignments.length ?? 0}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setAssignOpen(true)}
              className="btn btn-secondary flex items-center gap-2"
              disabled={!detail}
              title="Link an existing tenant phone number to this profile"
            >
              <Plus className="h-4 w-4" />
              Assign Existing
            </button>
            <button
              onClick={() => setProvisionOpen(true)}
              className="btn btn-primary flex items-center gap-2"
              disabled={!detail}
              title="Buy a new Twilio number and assign it in one step"
            >
              <ShoppingCart className="h-4 w-4" />
              Get &amp; Assign
            </button>
          </div>
        </div>
        {detail && detail.assignments.length > 0 ? (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="text-left px-4 py-2">Number</th>
                <th className="text-left px-4 py-2">Provider</th>
                <th className="text-left px-4 py-2">Role</th>
                <th className="text-left px-4 py-2">Default</th>
                <th className="text-left px-4 py-2">Priority</th>
                <th className="text-left px-4 py-2">Active</th>
                <th className="text-left px-4 py-2">Shared with</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {detail.assignments.map((a) => (
                <tr key={a.id}>
                  <td className="px-4 py-2 font-mono">{a.phoneNumber}</td>
                  <td className="px-4 py-2 text-gray-700">{a.provider}</td>
                  <td className="px-4 py-2">
                    <span className="px-1.5 py-0.5 text-[10px] rounded bg-gray-100 text-gray-600 font-mono">
                      {a.role}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    {a.isDefault ? (
                      <span className="inline-flex items-center gap-0.5 text-green-700 text-xs">
                        <CheckCircle2 className="h-3 w-3" />
                        yes
                      </span>
                    ) : (
                      <span className="text-xs text-gray-400">no</span>
                    )}
                  </td>
                  <td className="px-4 py-2 tabular-nums text-gray-700">{a.priority}</td>
                  <td className="px-4 py-2">
                    <span className={a.active ? 'text-green-700' : 'text-gray-400'}>
                      {a.active ? 'active' : 'inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    {a.isShared ? (
                      <div className="space-y-0.5">
                        <span className="inline-flex items-center gap-1 text-xs text-amber-700">
                          <Share2 className="h-3 w-3" />
                          {a.sharedWith.length} other profile
                          {a.sharedWith.length === 1 ? '' : 's'}
                        </span>
                        {a.sharedWith.slice(0, 3).map((s) => (
                          <Link
                            key={s.profileId}
                            to={`/admin/profiles/${s.profileId}`}
                            className="block text-[11px] text-gray-600 hover:text-primary-700 truncate max-w-xs"
                            title={s.profileName}
                          >
                            → {s.profileName}
                          </Link>
                        ))}
                        {a.sharedWith.length > 3 && (
                          <span className="block text-[11px] text-gray-400">
                            +{a.sharedWith.length - 3} more
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-gray-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="px-4 py-8 text-center">
            <div className="text-sm text-gray-700 font-medium">No phone numbers yet.</div>
            {detail?.platformId === 'hirefunnel' && (
              <div className="text-xs text-gray-500 mt-1">
                HireFunnel needs one sender number for SMS reminders.
              </div>
            )}
            <div className="text-xs text-gray-400 mt-1">
              Outbound from this profile will return <span className="font-mono">PROFILE_NOT_CONFIGURED</span>.
            </div>
            <button
              onClick={() => setProvisionOpen(true)}
              className="btn btn-primary inline-flex items-center gap-2 mt-3"
              disabled={!detail}
            >
              <ShoppingCart className="h-4 w-4" />
              {detail?.platformId === 'hirefunnel' ? 'Get Number' : 'Get & Assign Phone Number'}
            </button>
          </div>
        )}
      </div>

      {/* Recent messages */}
      <div className="card">
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
          <div className="font-medium text-gray-900 flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-gray-400" />
            Recent messages
            <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full tabular-nums">
              {detail?.recentMessages.length ?? 0}
            </span>
          </div>
        </div>
        {detail && detail.recentMessages.length > 0 ? (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="text-left px-4 py-2">When</th>
                <th className="text-left px-4 py-2">Dir</th>
                <th className="text-left px-4 py-2">From</th>
                <th className="text-left px-4 py-2">To</th>
                <th className="text-left px-4 py-2">Status</th>
                <th className="text-left px-4 py-2">Body</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {detail.recentMessages.map((m) => (
                <tr key={m.id}>
                  <td className="px-4 py-2 text-gray-500 whitespace-nowrap">{fmt(m.createdAt)}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`px-2 py-0.5 text-[10px] rounded-full ${
                        m.direction === 'in'
                          ? 'bg-blue-50 text-blue-700'
                          : 'bg-purple-50 text-purple-700'
                      }`}
                    >
                      {m.direction}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{m.fromNumber}</td>
                  <td className="px-4 py-2 font-mono text-xs">{m.toNumber}</td>
                  <td className="px-4 py-2 text-gray-700">{m.status}</td>
                  <td className="px-4 py-2 text-gray-600 max-w-md truncate" title={m.body}>
                    {m.body}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="px-4 py-6 text-center text-sm text-gray-400">
            No recent messages on this profile.
          </div>
        )}
      </div>

      {detail && (
        <>
          <AssignPhoneNumberModal
            isOpen={assignOpen}
            onClose={() => setAssignOpen(false)}
            onAssigned={() => {
              setAssignOpen(false);
              load();
            }}
            profileId={detail.id}
            profileDisplayName={detail.displayName}
          />
          <ProvisionAndAssignPhoneNumberModal
            isOpen={provisionOpen}
            onClose={() => setProvisionOpen(false)}
            onSuccess={() => {
              setProvisionOpen(false);
              load();
            }}
            target={{
              tenantId: detail.tenantId,
              profileId: detail.id,
              profileLabel: detail.displayName,
            }}
            intro={
              detail.platformId === 'hirefunnel'
                ? 'HireFunnel needs one sender number for SMS reminders.'
                : undefined
            }
          />
        </>
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
