import { IsEnum, IsOptional, IsString, IsObject, IsNotEmpty } from 'class-validator';
import { ProviderType } from '../../../database/entities/communication-integration.entity';

/**
 * Provider credentials block for ensure. All fields are optional at the DTO
 * layer — the semantics are:
 *   - If ANY credential field is supplied, the integration row's
 *     credentials_encrypted column is rotated to reflect the new values
 *     (merged with anything already stored, "new value wins" per key).
 *   - If NO credentials are supplied, the ensure call is a pure lookup —
 *     existing row is returned unchanged, or a new row is created with
 *     empty credentials (post-Task-8 mode).
 *
 * The union is intentionally loose. Twilio requires accountSid + authToken,
 * OpenPhone uses apiKey. Callers are expected to send the shape their
 * provider needs; missing fields are only "wrong" at rotation-time.
 */
export class EnsureIntegrationCredentialsDto {
  @IsString()
  @IsOptional()
  accountSid?: string;

  @IsString()
  @IsOptional()
  authToken?: string;

  @IsString()
  @IsOptional()
  apiKey?: string;

  @IsString()
  @IsOptional()
  webhookSecret?: string;
}

export class EnsureIntegrationDto {
  @IsString()
  @IsNotEmpty()
  tenantId: string;

  @IsEnum(ProviderType)
  provider: ProviderType;

  @IsObject()
  @IsOptional()
  credentials?: EnsureIntegrationCredentialsDto & Record<string, unknown>;

  @IsString()
  @IsOptional()
  friendlyName?: string;

  @IsString()
  @IsOptional()
  providerAccountId?: string;
}

export interface EnsureIntegrationResult {
  id: string;
  created: boolean;
  workspaceId: string;
  tenantId: string;
  provider: ProviderType;
  /**
   * Wave-2 Task 6B.5A — operational readiness. See ProvisionedIntegration
   * for enum semantics. Legacy consumers that ignore this field see the
   * pre-6B.5A shape unchanged.
   */
  operationalStatus: string;
  operationalReason: string | null;
}
