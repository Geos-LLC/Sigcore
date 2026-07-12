import { IsOptional, IsString, ValidateIf } from 'class-validator';

/**
 * Wave-2 Voice Foundation Phase 1 (PR 2) — DTO for
 *   PUT /v1/tenants/:tenantId/voice-webhook
 *
 * `voiceInboundUrl` may be:
 *   - a valid https URL (production/staging)
 *   - a valid http(s) URL to localhost/127.0.0.1 (test/dev mode only —
 *     enforced in the service layer against NODE_ENV, not in the DTO)
 *   - `null` to clear the stored value
 *   - omitted (also clears)
 *
 * The heavy URL validation (scheme allow-list, malformed URL rejection,
 * empty-string rejection, dev/test-mode plaintext-http allowance) lives in
 * the service layer where it can consult NODE_ENV. Keeping the DTO
 * class-validator surface minimal avoids duplicating the same rules in two
 * places with different behavior.
 */
export class SetVoiceWebhookDto {
  /**
   * Present-but-null = clear. Present-but-string = set (validated by service).
   * Absent = clear.
   */
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  voiceInboundUrl?: string | null;
}
