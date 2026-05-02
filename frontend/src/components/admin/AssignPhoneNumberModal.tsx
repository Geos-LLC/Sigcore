import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Loader2, Phone, X } from 'lucide-react';
import { adminApi } from '../../services/adminApi';
import type {
  AssignedProfilePhoneRow,
  ProfileAvailablePhoneRow,
} from '../../types';

export interface ProfileChoice {
  id: string;
  displayName: string;
  isDefault?: boolean;
}

interface AssignPhoneNumberModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAssigned: (row: AssignedProfilePhoneRow) => void;
  /** Pre-filled — the modal does not let the user change which profile receives the phone. */
  profileId: string;
  profileDisplayName: string;
  /**
   * When provided, the modal renders a profile picker above the number picker.
   * If the list contains a single profile, the picker is hidden and the modal
   * targets that profile directly (HireFunnel default-only flow).
   */
  profileChoices?: ProfileChoice[];
}

const PROVIDERS = ['twilio', 'openphone', 'whatsapp'] as const;

export default function AssignPhoneNumberModal({
  isOpen,
  onClose,
  onAssigned,
  profileId,
  profileDisplayName,
  profileChoices,
}: AssignPhoneNumberModalProps) {
  const [provider, setProvider] = useState<(typeof PROVIDERS)[number]>('twilio');
  const [rows, setRows] = useState<ProfileAvailablePhoneRow[]>([]);
  const [selectedTpnId, setSelectedTpnId] = useState<string>('');
  const [activeProfileId, setActiveProfileId] = useState<string>(profileId);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sync the active profile when the modal is reopened from a different page,
  // and clamp it to a valid choice when profileChoices is provided.
  useEffect(() => {
    if (!isOpen) return;
    if (profileChoices && profileChoices.length > 0) {
      const seed =
        profileChoices.find((p) => p.id === profileId)?.id ??
        profileChoices.find((p) => p.isDefault)?.id ??
        profileChoices[0].id;
      setActiveProfileId(seed);
    } else {
      setActiveProfileId(profileId);
    }
  }, [isOpen, profileId, profileChoices]);

  useEffect(() => {
    if (!isOpen || !activeProfileId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const out = await adminApi.getAvailablePhonesForProfile(activeProfileId);
        if (cancelled) return;
        setRows(out.rows);
      } catch (e: any) {
        if (cancelled) return;
        setError(e.response?.data?.message || e.message || 'Failed to load available numbers');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, activeProfileId]);

  // Filter to the chosen provider and exclude rows already assigned to this profile
  // (server still validates, but disabling client-side avoids accidental 409s).
  const eligible = useMemo(
    () =>
      rows.filter((r) => r.provider === provider && !r.alreadyAssignedToThisProfile),
    [rows, provider],
  );

  // Auto-select the first eligible number whenever the provider filter changes.
  useEffect(() => {
    if (eligible.length === 0) {
      setSelectedTpnId('');
      return;
    }
    if (!eligible.find((r) => r.tenantPhoneNumberId === selectedTpnId)) {
      setSelectedTpnId(eligible[0].tenantPhoneNumberId);
    }
  }, [eligible, selectedTpnId]);

  if (!isOpen) return null;

  const handleConfirm = async () => {
    if (!selectedTpnId || !activeProfileId) return;
    setSubmitting(true);
    setError(null);
    try {
      const row = await adminApi.assignPhoneToProfile({
        profileId: activeProfileId,
        tenantPhoneNumberId: selectedTpnId,
      });
      onAssigned(row);
    } catch (e: any) {
      setError(e.response?.data?.message || e.message || 'Failed to assign phone number');
    } finally {
      setSubmitting(false);
    }
  };

  // Hide the profile picker entirely for single-profile businesses (HireFunnel).
  const showProfilePicker = !!profileChoices && profileChoices.length > 1;
  const activeProfileLabel =
    profileChoices?.find((p) => p.id === activeProfileId)?.displayName ?? profileDisplayName;

  const noNumbersForTenant = !loading && rows.length === 0;
  const noNumbersForProvider = !loading && rows.length > 0 && eligible.length === 0;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Phone className="h-5 w-5 text-gray-400" />
              Assign Phone Number
            </h2>
            <p className="text-xs text-gray-500 mt-1">
              to <span className="font-medium text-gray-700">{activeProfileLabel}</span>
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
            disabled={submitting}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4">
          {showProfilePicker && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Profile
              </label>
              <select
                value={activeProfileId}
                onChange={(e) => setActiveProfileId(e.target.value)}
                className="input w-full"
                disabled={submitting}
              >
                {profileChoices!.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                    {p.isDefault ? ' · default' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Select provider
            </label>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as (typeof PROVIDERS)[number])}
              className="input w-full"
              disabled={loading || submitting}
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p[0].toUpperCase() + p.slice(1)}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Select number
            </label>
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-gray-500 px-2 py-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading available numbers…
              </div>
            ) : noNumbersForTenant ? (
              <div className="text-xs text-gray-500 px-2 py-2 border border-dashed border-gray-200 rounded">
                No phone numbers allocated to this tenant yet. Add one via Provisioning.
              </div>
            ) : noNumbersForProvider ? (
              <div className="text-xs text-gray-500 px-2 py-2 border border-dashed border-gray-200 rounded">
                No unassigned {provider} numbers in this tenant.
              </div>
            ) : (
              <select
                value={selectedTpnId}
                onChange={(e) => setSelectedTpnId(e.target.value)}
                className="input w-full font-mono"
                disabled={submitting}
              >
                {eligible.map((r) => (
                  <option key={r.tenantPhoneNumberId} value={r.tenantPhoneNumberId}>
                    {r.phoneNumber}
                    {r.friendlyName ? `  ·  ${r.friendlyName}` : ''}
                    {r.sharedWithProfileIds.length > 0 ? '  · shared' : ''}
                  </option>
                ))}
              </select>
            )}
          </div>

          {!showProfilePicker && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Assign to profile
              </label>
              <div className="text-sm text-gray-700 px-3 py-2 bg-gray-50 rounded border border-gray-200">
                {activeProfileLabel}
              </div>
            </div>
          )}
        </div>

        {error && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800 flex items-start gap-2">
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex justify-end gap-3 mt-6">
          <button onClick={onClose} className="btn btn-secondary" disabled={submitting}>
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            className="btn btn-primary flex items-center gap-2"
            disabled={submitting || !selectedTpnId || loading}
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
