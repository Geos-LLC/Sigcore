import { BadRequestException } from '@nestjs/common';

/**
 * Wave-2 Voice Foundation Phase 1 (PR 2) — validate a candidate
 * `voice_inbound_url` value.
 *
 * Accept:
 *   - https:// URLs (any host, any port, any path)
 *   - http:// or https:// URLs targeting localhost / 127.0.0.1 ONLY when
 *     `allowInsecureLocalhost` is true (production always sets this false)
 *
 * Reject with 400 (BadRequestException):
 *   - non-string input (unless null — handled by the caller before this)
 *   - empty / whitespace-only string
 *   - malformed URL (throws inside `new URL()`)
 *   - scheme is anything other than http/https
 *     (ftp:, ws:, wss:, file:, javascript:, data:, gopher:, etc.)
 *   - http:// to a non-localhost host in production
 *
 * The function returns the normalized string (via `URL.toString()`) on
 * success — trailing slashes collapsed, whitespace trimmed. This is what
 * gets persisted so the read path returns a predictable canonical form.
 */
export function validateVoiceInboundUrl(
  candidate: unknown,
  opts: { allowInsecureLocalhost: boolean },
): string {
  if (typeof candidate !== 'string') {
    throw new BadRequestException(
      'voiceInboundUrl must be a string (or null to clear)',
    );
  }
  const trimmed = candidate.trim();
  if (trimmed.length === 0) {
    throw new BadRequestException(
      'voiceInboundUrl cannot be an empty string — pass null to clear',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new BadRequestException(
      `voiceInboundUrl is not a valid URL: ${trimmed}`,
    );
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new BadRequestException(
      `voiceInboundUrl scheme must be https (got ${protocol}). ` +
        `Rejected schemes: ftp, ws, wss, file, javascript, data, gopher, etc.`,
    );
  }

  if (protocol === 'http:') {
    // Only accept http:// to localhost / 127.0.0.1 when the caller explicitly
    // allows it. Production must always reject plaintext http.
    const host = parsed.hostname.toLowerCase();
    const isLocal =
      host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    if (!opts.allowInsecureLocalhost || !isLocal) {
      throw new BadRequestException(
        `voiceInboundUrl must use https (received http). ` +
          `Plaintext http is only accepted for localhost in dev/test mode.`,
      );
    }
  }

  return parsed.toString();
}
