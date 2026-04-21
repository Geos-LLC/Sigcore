/**
 * Canonical phone normalization for Sigcore.
 *
 * All writes to openphone_contact_snapshot.phone_e164,
 * communication_participants.normalized_phone_e164, and
 * communication_conversations.participant_phone_e164 MUST go through this util.
 *
 * Current impl is US-only (prepend +1 to last-10 digits). Swap for
 * libphonenumber-js later without touching call sites — see plan §5 / Open Q 16.1.
 */

export interface NormalizedPhone {
  e164: string | null;
  last10: string | null;
}

export function normalizeToE164(raw: string | null | undefined): NormalizedPhone {
  if (!raw) return { e164: null, last10: null };
  const cleaned = String(raw).replace(/[^\d+]/g, '');
  if (!cleaned) return { e164: null, last10: null };

  let e164: string | null = null;
  if (cleaned.startsWith('+')) {
    const digits = cleaned.slice(1);
    if (digits.length < 7 || digits.length > 15) return { e164: null, last10: null };
    e164 = cleaned;
  } else if (cleaned.length === 10) {
    e164 = `+1${cleaned}`;
  } else if (cleaned.length === 11 && cleaned.startsWith('1')) {
    e164 = `+${cleaned}`;
  } else {
    return { e164: null, last10: null };
  }

  const digitsOnly = e164.replace(/\D/g, '');
  const last10 = digitsOnly.length >= 10 ? digitsOnly.slice(-10) : null;
  return { e164, last10 };
}

export function last10Digits(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits || null;
}
