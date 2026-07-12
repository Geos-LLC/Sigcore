import { IsString, IsNotEmpty, IsOptional, IsUrl, ValidateIf } from 'class-validator';

/**
 * Wave-2 Task 4 — DTO for
 *   POST /v1/phone-numbers/:tpnId/webhook-config
 *
 * At least one of the URL fields must be present, otherwise the handler
 * returns 400 (per runbook boundary case `boundary_empty_body_returns_400`).
 * That "at-least-one" rule is enforced in the service, not with class-validator,
 * because class-validator's cross-field validation gets ugly fast; the service
 * layer already needs to inspect the fields to decide what to write.
 */
export class WebhookConfigDto {
  @IsString()
  @IsNotEmpty()
  integrationId: string;

  @ValidateIf((_o, v) => v !== undefined)
  @IsUrl({ require_tld: false })
  @IsOptional()
  voiceUrl?: string;

  @ValidateIf((_o, v) => v !== undefined)
  @IsUrl({ require_tld: false })
  @IsOptional()
  voiceFallbackUrl?: string;

  @ValidateIf((_o, v) => v !== undefined)
  @IsUrl({ require_tld: false })
  @IsOptional()
  smsUrl?: string;

  @ValidateIf((_o, v) => v !== undefined)
  @IsUrl({ require_tld: false })
  @IsOptional()
  statusCallbackUrl?: string;
}

export interface WebhookConfigResult {
  tpnId: string;
  applied: {
    voiceUrl?: string;
    voiceFallbackUrl?: string;
    smsUrl?: string;
    statusCallbackUrl?: string;
  };
}
