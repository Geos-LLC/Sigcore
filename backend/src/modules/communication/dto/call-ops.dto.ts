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
   *   - 'media_stream' (Phase C.2): mint a signed single-use session token
   *     and return `<Response><Connect><Stream url="{mediaStreamWssBaseUrl}?session={token}"/></Connect></Response>`
   *     so Twilio opens a WSS to Callio. Requires `mediaStreamWssBaseUrl`
   *     AND `callioCallId` to be set — the token binds workspace, tenant,
   *     integration, providerCallSid, and callioCallId so Callio can look
   *     up the pre-created voice_calls row and drop the stream into an
   *     orchestrator instance.
   */
  @IsString()
  @IsOptional()
  @IsIn(['hangup', 'twiml_url', 'media_stream'])
  answerMode?: 'hangup' | 'twiml_url' | 'media_stream';

  @IsString()
  @IsOptional()
  answerTwimlUrl?: string;

  /**
   * Phase C.2 — Callio's WSS base URL for the AI media stream. Sigcore
   * appends `?session=<token>` when constructing the TwiML `<Stream url>`.
   * Must start with wss:// (ws:// only permitted for localhost in dev/test).
   * Required when answerMode='media_stream'.
   */
  @IsString()
  @IsOptional()
  mediaStreamWssBaseUrl?: string;

  /**
   * Phase C.2 — Callio's own voice_calls.id for the outbound call. The
   * caller creates the row BEFORE dialing so orchestrator wiring on the
   * Callio side (bootstrapped when the WSS opens) can find its state
   * without a lookup roundtrip. Baked into the session token so an
   * attacker with a valid signature cannot substitute a different callId.
   * Required when answerMode='media_stream'.
   */
  @IsString()
  @IsOptional()
  callioCallId?: string;

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

  /**
   * P0-2 (2026-08-15) — per-call opt-in Twilio Answering Machine
   * Detection (AMD). Default: disabled (preserves existing behavior;
   * dial-wide AMD was reverted 2026-08-12 due to iOS-Call-Screening
   * false positives — see twilio-voice.service.ts:82-100).
   *
   * When set to 'enabled', Sigcore requests Twilio's ASYNC AMD:
   *   machineDetection = 'DetectMessageEnd'
   *   asyncAmd = 'true'
   *   asyncAmdStatusCallback = <same wrapped URL as statusCallbackUrl>
   * so Twilio POSTs an additional callback carrying `AnsweredBy` when
   * detection completes. This never blocks the call — the media stream
   * opens as usual on 'answered' and the caller (Callio's orchestrator)
   * decides at first-turn whether to speak normally or switch to
   * voicemail-message mode based on the AnsweredBy value.
   *
   * Consumers (LB Wave-4 AI-outbound) opt in per call. All other dial
   * paths (MockCustomer whisper-bridge, canary dials, ad-hoc ops)
   * leave this unset and see identical behavior to today.
   */
  @IsString()
  @IsOptional()
  @IsIn(['enabled', 'disabled'])
  machineDetection?: 'enabled' | 'disabled';
}

export interface DialCallResult {
  providerCallSid: string;
  status: string;
  fromNumber: string;
  toNumber: string;
  createdAt: string;
  integrationId: string;
}
