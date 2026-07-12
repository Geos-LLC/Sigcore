import { IsString, IsOptional, IsBoolean, IsNumber, IsEnum, Min, Max } from 'class-validator';
import { Transform } from 'class-transformer';
import { PricingType } from '../../../database/entities';

export class SearchPhoneNumbersDto {
  @IsString()
  country: string;

  @IsString()
  @IsOptional()
  areaCode?: string;

  @IsString()
  @IsOptional()
  locality?: string;

  @IsString()
  @IsOptional()
  region?: string;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  smsCapable?: boolean;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  voiceCapable?: boolean;
}

/**
 * Wave-2 Voice Foundation Phase 1 (PR 4) — purchase channel selector.
 *
 *   sms   — SMS-only allocation (backward-compatible default when field
 *           omitted). Twilio number gets an SMS webhook URL. A2P
 *           attachment runs.
 *   voice — Voice-only allocation. Twilio number gets a Voice URL +
 *           StatusCallback. A2P attachment is skipped.
 *   both  — SMS + voice. Both URL sets are configured. A2P attachment
 *           runs.
 */
export type PurchaseChannel = 'sms' | 'voice' | 'both';

export class PurchasePhoneNumberDto {
  @IsString()
  phoneNumber: string;

  @IsString()
  @IsOptional()
  friendlyName?: string;

  /**
   * Requested channel for this allocation. Defaults to 'sms' when omitted
   * so existing callers get byte-identical behaviour vs pre-PR-4.
   */
  @IsEnum(['sms', 'voice', 'both'] as const)
  @IsOptional()
  channel?: PurchaseChannel;
}

export class UpdatePricingConfigDto {
  @IsEnum(PricingType)
  @IsOptional()
  pricingType?: PricingType;

  @IsNumber()
  @IsOptional()
  @Min(0)
  monthlyBasePrice?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  monthlyMarkupAmount?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(1000)
  monthlyMarkupPercentage?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  setupFee?: number;

  @IsBoolean()
  @IsOptional()
  allowTenantPurchase?: boolean;

  @IsBoolean()
  @IsOptional()
  allowTenantRelease?: boolean;

  @IsString()
  @IsOptional()
  messagingServiceSid?: string;
}

// Response DTOs

export class AvailableNumberResponse {
  phoneNumber: string;
  locality?: string;
  region?: string;
  country: string;
  capabilities: string[];
  pricing: {
    twilioCost: number;
    markupAmount: number;
    totalMonthlyPrice: number;
    setupFee: number;
  };
}

export class PhoneNumberOrderResponse {
  id: string;
  workspaceId: string;
  tenantId?: string;
  phoneNumber?: string;
  orderType: string;
  status: string;
  twilioCost: number;
  markupAmount: number;
  totalPrice: number;
  createdAt: Date;
  completedAt?: Date;
  metadata?: Record<string, unknown>;
}

export class PricingConfigResponse {
  pricingType: PricingType;
  monthlyBasePrice?: number;
  monthlyMarkupAmount: number;
  monthlyMarkupPercentage: number;
  setupFee: number;
  allowTenantPurchase: boolean;
  allowTenantRelease: boolean;
  messagingServiceSid?: string;
}

export class PurchaseResultResponse {
  success: boolean;
  order: PhoneNumberOrderResponse;
  allocation?: {
    id: string;
    phoneNumber: string;
    friendlyName?: string;
    provider: string;
    monthlyCost: number;
    provisionedAt: Date;
    a2pStatus?: string;
    messagingServiceSid?: string;
  };
  error?: string;
}

export class ReleaseResultResponse {
  success: boolean;
  order: PhoneNumberOrderResponse;
  error?: string;
}
