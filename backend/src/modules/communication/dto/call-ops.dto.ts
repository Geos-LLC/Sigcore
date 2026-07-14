import { IsString, IsNotEmpty, IsOptional, IsIn, IsArray, ArrayNotEmpty } from 'class-validator';

/**
 * Wave-2 Task 3 — DTOs for the new Sigcore-side call operations
 *   POST /v1/calls/:providerCallSid/recording/start
 *   POST /v1/calls/:providerCallSid/hangup
 *
 * Both endpoints require `integrationId` in the body so
 * IntegrationResourceGuard can perform the 4-way validation (workspace,
 * tenant, integration, resource↔integration).
 */

export class RecordingStartDto {
  @IsString()
  @IsNotEmpty()
  integrationId: string;

  /**
   * Task 6B.5B — tenantId is now required for IntegrationResourceGuard's
   * check 2. Callio populates from `workspace.sigcore_tenant_id`.
   * Task 6B.5C uses it as the tenantId that ends up in the forwarded
   * callback HMAC envelope.
   */
  @IsString()
  @IsOptional()
  tenantId?: string;

  @IsString()
  @IsOptional()
  @IsIn(['mono', 'dual'])
  recordingChannels?: 'mono' | 'dual';

  @IsString()
  @IsOptional()
  statusCallbackUrl?: string;

  @IsArray()
  @ArrayNotEmpty()
  @IsOptional()
  statusCallbackEvents?: string[];
}

export class HangupDto {
  @IsString()
  @IsNotEmpty()
  integrationId: string;

  /** Task 6B.5B — tenantId required for IntegrationResourceGuard check 2. */
  @IsString()
  @IsOptional()
  tenantId?: string;

  @IsString()
  @IsOptional()
  reason?: string;
}

export interface RecordingStartResult {
  recordingSid: string;
  status: string;
}

export interface HangupResult {
  providerCallSid: string;
  status: 'completed';
}

/**
 * Wave-2 Phase C — outbound dial DTO.
 *
 * POST /api/v1/calls/dial creates an outbound provider call under the
 * calling tenant's phone number (fromNumber must be a tenant_phone_numbers
 * row owned by the guard-verified workspace + tenant).
 *
 * Idempotency: HTTP header `Idempotency-Key` is required. Same key + same
 * body within the TTL window returns the prior response verbatim; same key
 * + different body returns 409 Conflict.
 */
export class DialCallDto {
  @IsString()
  @IsNotEmpty()
  integrationId: string;

  @IsString()
  @IsNotEmpty()
  tenantId: string;

  /**
   * E.164 caller ID. MUST be a tenant_phone_numbers row owned by
   * (workspaceId, tenantId) with `channel` in {'voice','both'}. Cross-
   * workspace or SMS-only numbers are rejected 400.
   */
  @IsString()
  @IsNotEmpty()
  fromNumber: string;

  /** E.164 destination. */
  @IsString()
  @IsNotEmpty()
  toNumber: string;

  /**
   * What to serve as the call-answer TwiML when the destination picks up.
   *   - 'hangup' (default): return `<Response><Hangup/></Response>` —
   *     useful for connectivity canaries.
   *   - 'twiml_url': return `<Response><Redirect>{answerTwimlUrl}</Redirect></Response>`,
   *     letting the caller host arbitrary answer TwiML. Requires
   *     `answerTwimlUrl` to be set.
   *
   * Phase C.2 will add `media_stream` for Attach AI / voicemail flows.
   */
  @IsString()
  @IsOptional()
  @IsIn(['hangup', 'twiml_url'])
  answerMode?: 'hangup' | 'twiml_url';

  @IsString()
  @IsOptional()
  answerTwimlUrl?: string;

  @IsString()
  @IsOptional()
  @IsIn(['mono', 'dual'])
  recordingChannels?: 'mono' | 'dual';

  /** Ring timeout in seconds. Default 30, max 600 (10 minutes). */
  @IsOptional()
  timeoutSeconds?: number;

  /** Callio-supplied statusCallback URL. Sigcore wraps it in a signed token
   *  the same way Phase B does for recording-status callbacks. */
  @IsString()
  @IsOptional()
  statusCallbackUrl?: string;
}

export interface DialCallResult {
  providerCallSid: string;
  status: string;
  fromNumber: string;
  toNumber: string;
  createdAt: string;
  integrationId: string;
}
