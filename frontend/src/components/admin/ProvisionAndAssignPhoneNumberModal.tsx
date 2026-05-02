import { useEffect, useState } from 'react';
import { AlertCircle, Loader2, Phone, ShoppingCart, X } from 'lucide-react';
import { adminApi } from '../../services/adminApi';
import type { ProvisionAndAssignResult } from '../../types';

/**
 * One option in the optional context picker rendered when the caller has more
 * than one (workspace, profile) target — e.g. the Platform detail button on a
 * platform with multiple workspaces or profiles.
 */
export interface ProvisionContextChoice {
  /** Stable composite id used by the picker. */
  key: string;
  /** Label shown in the dropdown — e.g. "Spotless Tampa › Thumbtack". */
  label: string;
  tenantId: string;
  profileId: string;
  /** Optional sub-label printed under the picker for confirmation. */
  workspaceLabel?: string;
  profileLabel?: string;
}

interface ProvisionAndAssignPhoneNumberModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (result: ProvisionAndAssignResult) => void;
  /**
   * Single-target mode (Profile detail / Business detail with one profile).
   * Mutually exclusive with `choices`.
   */
  target?: { tenantId: string; profileId: string; profileLabel: string };
  /**
   * Multi-target mode (Platform / Business detail with many profiles). When
   * exactly one choice is provided the picker is hidden and the modal targets
   * that choice directly — this is the HireFunnel auto-skip path.
   */
  choices?: ProvisionContextChoice[];
  /** Pre-fill copy for HireFunnel and similar single-purpose platforms. */
  intro?: string;
}

const PROVIDERS = ['twilio'] as const;

export default function ProvisionAndAssignPhoneNumberModal({
  isOpen,
  onClose,
  onSuccess,
  target,
  choices,
  intro,
}: ProvisionAndAssignPhoneNumberModalProps) {
  const initialChoiceKey =
    choices && choices.length > 0 ? choices[0].key : '';
  const [choiceKey, setChoiceKey] = useState<string>(initialChoiceKey);
  const [areaCode, setAreaCode] = useState('');
  const [locality, setLocality] = useState('');
  const [smsCapable, setSmsCapable] = useState(true);
  const [voiceCapable, setVoiceCapable] = useState(true);
  const [makeDefault, setMakeDefault] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    setSubmitting(false);
    setAreaCode('');
    setLocality('');
    setSmsCapable(true);
    setVoiceCapable(true);
    setMakeDefault(true);
    if (choices && choices.length > 0) {
      setChoiceKey(choices[0].key);
    }
  }, [isOpen, choices]);

  if (!isOpen) return null;

  const showPicker = !!choices && choices.length > 1;
  const activeChoice =
    choices?.find((c) => c.key === choiceKey) ?? choices?.[0] ?? null;

  const resolvedTarget = target ?? (activeChoice
    ? {
        tenantId: activeChoice.tenantId,
        profileId: activeChoice.profileId,
        profileLabel: activeChoice.profileLabel ?? activeChoice.label,
      }
    : null);

  const canSubmit =
    !!resolvedTarget && !submitting && (smsCapable || voiceCapable);

  const handleSubmit = async () => {
    if (!resolvedTarget) return;
    setSubmitting(true);
    setError(null);
    try {
      const capabilities: Array<'sms' | 'voice'> = [];
      if (smsCapable) capabilities.push('sms');
      if (voiceCapable) capabilities.push('voice');
      const result = await adminApi.provisionAndAssignPhoneNumber({
        tenantId: resolvedTarget.tenantId,
        profileId: resolvedTarget.profileId,
        provider: 'twilio',
        country: 'US',
        areaCode: areaCode.trim() || undefined,
        locality: locality.trim() || undefined,
        capabilities,
        makeDefault,
      });
      onSuccess(result);
    } catch (e: any) {
      setError(e.response?.data?.message || e.message || 'Failed to provision number');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
        <div className="flex items-start justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <ShoppingCart className="h-5 w-5 text-gray-400" />
              Get &amp; Assign Phone Number
            </h2>
            {resolvedTarget && (
              <p className="text-xs text-gray-500 mt-1">
                to <span className="font-medium text-gray-700">{resolvedTarget.profileLabel}</span>
              </p>
            )}
            {intro && <p className="text-xs text-gray-500 mt-2">{intro}</p>}
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
          {showPicker && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Profile
              </label>
              <select
                value={choiceKey}
                onChange={(e) => setChoiceKey(e.target.value)}
                className="input w-full"
                disabled={submitting}
              >
                {choices!.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Provider
            </label>
            <select className="input w-full" value="twilio" disabled>
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p[0].toUpperCase() + p.slice(1)}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Area code
              </label>
              <input
                type="text"
                className="input w-full"
                placeholder="415"
                value={areaCode}
                onChange={(e) => setAreaCode(e.target.value)}
                disabled={submitting}
                maxLength={5}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Locality (optional)
              </label>
              <input
                type="text"
                className="input w-full"
                placeholder="San Francisco"
                value={locality}
                onChange={(e) => setLocality(e.target.value)}
                disabled={submitting}
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Capabilities
            </label>
            <div className="flex items-center gap-4 text-sm">
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={smsCapable}
                  onChange={(e) => setSmsCapable(e.target.checked)}
                  disabled={submitting}
                />
                SMS
              </label>
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={voiceCapable}
                  onChange={(e) => setVoiceCapable(e.target.checked)}
                  disabled={submitting}
                />
                Voice
              </label>
            </div>
          </div>

          <div>
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={makeDefault}
                onChange={(e) => setMakeDefault(e.target.checked)}
                disabled={submitting}
              />
              Make this the profile&apos;s default number
            </label>
          </div>

          <div className="text-xs text-gray-500 px-3 py-2 bg-amber-50 border border-amber-200 rounded">
            <Phone className="h-3 w-3 inline -mt-0.5 mr-1" />
            We&apos;ll buy the first available Twilio number that matches your
            search. Carrier fees apply on the workspace&apos;s Twilio account.
          </div>
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
            onClick={handleSubmit}
            className="btn btn-primary flex items-center gap-2"
            disabled={!canSubmit}
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Buy &amp; Assign
          </button>
        </div>
      </div>
    </div>
  );
}
