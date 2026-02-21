/**
 * Attempts to coerce a user-typed phone string into E.164 format.
 *
 * Rules (US/Canada focus, works for other countries if + is provided):
 *   - Strip spaces, dashes, dots, parentheses
 *   - 10 digits (no country code)  → +1XXXXXXXXXX
 *   - 11 digits starting with 1    → +1XXXXXXXXXX
 *   - Already starts with +        → keep as-is (strip formatting only)
 *   - Anything else                → return cleaned input unchanged
 */
export function formatPhoneE164(raw: string): string {
  if (!raw) return raw;

  // Keep the leading + if present, then strip all non-digits from the rest
  const hasPlus = raw.trimStart().startsWith('+');
  const digits = raw.replace(/\D/g, '');

  if (!digits) return raw;

  if (hasPlus) {
    // Already had country code indicator — just clean up formatting
    return `+${digits}`;
  }

  if (digits.length === 10) {
    // US/Canada local number
    return `+1${digits}`;
  }

  if (digits.length === 11 && digits.startsWith('1')) {
    // US/Canada with leading 1
    return `+${digits}`;
  }

  // Unknown format — return cleaned digits only, don't add + to avoid false positives
  return digits;
}

/**
 * Returns true if the value looks like a valid E.164 number.
 * Accepts any + followed by 7-15 digits (ITU-T standard).
 */
export function isValidE164(value: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(value);
}
