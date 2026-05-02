import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Building2,
  Phone,
  Plus,
  RefreshCw,
  AlertCircle,
  ChevronRight,
  MapPin,
  Share2,
  ShoppingCart,
  CheckCircle2,
} from 'lucide-react';
import { adminApi } from '../../services/adminApi';
import type { BusinessDetail } from '../../types';
import { IdChip } from '../../components/admin/IdChip';
import { SourceBadge } from '../../components/admin/SourceBadge';
import AssignPhoneNumberModal, {
  type ProfileChoice,
} from '../../components/admin/AssignPhoneNumberModal';
import ProvisionAndAssignPhoneNumberModal, {
  type ProvisionContextChoice,
} from '../../components/admin/ProvisionAndAssignPhoneNumberModal';

export default function AdminBusinessDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<BusinessDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // After LB profile materialization, demoted "Default" profiles linger for
  // back-compat. Hide them by default; operators can flip the toggle.
  const [showKeptDefaults, setShowKeptDefaults] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [provisionOpen, setProvisionOpen] = useState(false);

  const visibleProfiles = useMemo(() => {
    if (!detail) return [];
    if (showKeptDefaults) return detail.profiles;
    return detail.profiles.filter(
      (p) => !(p.slug === 'default' && !p.isDefault),
    );
  }, [detail, showKeptDefaults]);
  const hiddenCount = (detail?.profiles.length ?? 0) - visibleProfiles.length;

  // Profiles eligible to receive a phone assignment from this page. We exclude
  // demoted "kept default" profiles (slug='default' but isDefault=false) since
  // those are legacy artifacts; the Profile detail page can still target them.
  const assignableProfiles = useMemo<ProfileChoice[]>(() => {
    if (!detail) return [];
    return detail.profiles
      .filter((p) => !(p.slug === 'default' && !p.isDefault))
      .map((p) => ({
        id: p.id,
        displayName: p.displayName,
        isDefault: p.isDefault,
      }));
  }, [detail]);

  const seedProfileId =
    assignableProfiles.find((p) => p.isDefault)?.id ?? assignableProfiles[0]?.id ?? '';
  const seedProfileLabel =
    assignableProfiles.find((p) => p.id === seedProfileId)?.displayName ?? '';

  // PR16 — context choices for the provision modal. When the business has a
  // single eligible profile we pass a one-element list so the modal hides its
  // picker (HireFunnel "skip selection" path).
  const provisionChoices = useMemo<ProvisionContextChoice[]>(() => {
    if (!detail) return [];
    return assignableProfiles.map((p) => ({
      key: p.id,
      label: p.displayName + (p.isDefault ? ' · default' : ''),
      tenantId: detail.tenantId,
      profileId: p.id,
      profileLabel: p.displayName,
    }));
  }, [detail, assignableProfiles]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setDetail(await adminApi.getBusiness(id));
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Failed to load business');
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
          <Link to="/admin/businesses" className="text-gray-400 hover:text-gray-700 mt-1">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <Building2 className="h-5 w-5 text-gray-400" />
              <h1 className="text-2xl font-bold text-gray-900">{detail?.displayName ?? id}</h1>
              {detail && <SourceBadge source={detail.sources[0] ?? 'internal'} />}
            </div>
            <div className="text-sm text-gray-500 mt-1 flex items-center gap-4 flex-wrap">
              <IdChip label="business id" value={detail?.id} />
              <IdChip label="tenant" value={detail?.tenantId} />
              <IdChip label="external" value={detail?.externalBusinessId ?? null} />
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

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Profiles" value={detail?.profileCount} icon={<MapPin className="h-4 w-4" />} />
        <Stat label="Phones" value={detail?.phoneCount} icon={<Phone className="h-4 w-4" />} />
        <Stat label="Status" value={detail?.status} icon={<CheckCircle2 className="h-4 w-4" />} />
        <Stat label="Slug" value={detail?.slug} icon={<MapPin className="h-4 w-4" />} />
      </div>

      {/* Profiles */}
      <div className="card">
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
          <div className="font-medium text-gray-900 flex items-center gap-2">
            <MapPin className="h-4 w-4 text-gray-400" />
            Profiles
            <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full tabular-nums">
              {visibleProfiles.length}
              {hiddenCount > 0 ? ` of ${detail?.profiles.length ?? 0}` : ''}
            </span>
          </div>
          {hiddenCount > 0 && (
            <button
              onClick={() => setShowKeptDefaults((v) => !v)}
              className="text-xs text-gray-500 hover:text-gray-800"
              title="Demoted Default profiles kept for backward compatibility"
            >
              {showKeptDefaults
                ? 'Hide kept defaults'
                : `Show kept defaults (${hiddenCount})`}
            </button>
          )}
        </div>
        {detail && visibleProfiles.length > 0 ? (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="text-left px-4 py-2">Profile</th>
                <th className="text-left px-4 py-2">Source</th>
                <th className="text-left px-4 py-2">Default</th>
                <th className="text-left px-4 py-2">Phones</th>
                <th className="text-left px-4 py-2">External id</th>
                <th className="text-right px-4 py-2 w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {visibleProfiles.map((p) => (
                <tr key={p.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2">
                    <Link
                      to={`/admin/profiles/${p.id}`}
                      className="font-medium text-gray-900 hover:text-primary-700"
                    >
                      {p.displayName}
                    </Link>
                    <div className="mt-0.5">
                      <IdChip label="profile" value={p.id} />
                    </div>
                  </td>
                  <td className="px-4 py-2">
                    <SourceBadge source={p.source} />
                  </td>
                  <td className="px-4 py-2">
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
                  <td className="px-4 py-2">
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
                  <td className="px-4 py-2">
                    <IdChip value={p.externalProfileId} />
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Link
                      to={`/admin/profiles/${p.id}`}
                      className="inline-flex items-center text-primary-600 hover:text-primary-800"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="px-4 py-6 text-center text-sm text-gray-400">
            No profiles in this business.
          </div>
        )}
      </div>

      {/* Phones */}
      <div className="card">
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
          <div className="font-medium text-gray-900 flex items-center gap-2">
            <Phone className="h-4 w-4 text-gray-400" />
            Phone numbers
            <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full tabular-nums">
              {detail?.phones.length ?? 0}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setAssignOpen(true)}
              className="btn btn-secondary flex items-center gap-2"
              disabled={!detail || assignableProfiles.length === 0}
              title={
                assignableProfiles.length === 0
                  ? 'No assignable profiles in this business'
                  : 'Link an existing tenant phone number to a profile'
              }
            >
              <Plus className="h-4 w-4" />
              Assign Existing
            </button>
            <button
              onClick={() => setProvisionOpen(true)}
              className="btn btn-primary flex items-center gap-2"
              disabled={!detail || assignableProfiles.length === 0}
              title={
                assignableProfiles.length === 0
                  ? 'No assignable profiles in this business'
                  : 'Buy a new Twilio number and assign it'
              }
            >
              <ShoppingCart className="h-4 w-4" />
              Get &amp; Assign
            </button>
          </div>
        </div>
        {detail && detail.phones.length > 0 ? (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="text-left px-4 py-2">Number</th>
                <th className="text-left px-4 py-2">Provider</th>
                <th className="text-left px-4 py-2">A2P</th>
                <th className="text-left px-4 py-2">Profiles</th>
                <th className="text-left px-4 py-2">Shared?</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {detail.phones.map((ph) => (
                <tr key={ph.tenantPhoneNumberId}>
                  <td className="px-4 py-2 font-mono">{ph.phoneNumber}</td>
                  <td className="px-4 py-2 text-gray-700">{ph.provider}</td>
                  <td className="px-4 py-2 text-gray-500">{ph.a2pStatus ?? '—'}</td>
                  <td className="px-4 py-2 tabular-nums text-gray-700">
                    {ph.assignedProfileIds.length}
                  </td>
                  <td className="px-4 py-2">
                    {ph.isShared ? (
                      <span className="inline-flex items-center gap-1 text-xs text-amber-700">
                        <Share2 className="h-3 w-3" />
                        shared
                      </span>
                    ) : (
                      <span className="text-xs text-gray-400">no</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="px-4 py-8 text-center">
            <div className="text-sm text-gray-700 font-medium">No phone numbers yet.</div>
            <div className="text-xs text-gray-400 mt-1">
              Assign an existing tenant number or buy a new one to get this business
              sending and receiving messages.
            </div>
            <button
              onClick={() => setProvisionOpen(true)}
              className="btn btn-primary inline-flex items-center gap-2 mt-3"
              disabled={!detail || assignableProfiles.length === 0}
            >
              <ShoppingCart className="h-4 w-4" />
              Get &amp; Assign Phone Number
            </button>
          </div>
        )}
      </div>

      {detail && seedProfileId && (
        <AssignPhoneNumberModal
          isOpen={assignOpen}
          onClose={() => setAssignOpen(false)}
          onAssigned={() => {
            setAssignOpen(false);
            load();
          }}
          profileId={seedProfileId}
          profileDisplayName={seedProfileLabel}
          profileChoices={assignableProfiles}
        />
      )}

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
            detail.platformId === 'hirefunnel'
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
