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
