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
