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

/**
 * PATCH /api/tenants/:id/phone-numbers/:allocationId/channels
 *
 * Update an existing allocation's channel configuration in-place without
 * DELETE + repurchase. Written in response to the Globus 2026-08 audit
 * (see docs/AUDIT_TPN_ACTIVECHANNELS_STUCK.md) — SMS-only TPNs whose
 * underlying Twilio number supports voice were previously only fixable
 * via ops SQL or by swapping the phone number entirely.
 *
 * Primary use case: upgrading SMS → both when the underlying Twilio
 * number's capabilities support voice. Downgrades (removing SMS or
 * voice from an existing allocation) are supported symmetrically for
 * correctness but should be used cautiously — in-flight conversations
 * on the removed channel will be silently dropped.
 */
export class UpdatePhoneChannelDto {
  @IsEnum(['sms', 'voice', 'both'] as const)
  channel: PurchaseChannel;

  /**
   * When true, skip the Twilio-side webhook update entirely. Sigcore's
   * `metadata.activeChannels`, `metadata.requestedChannel`, `metadata.capabilities`
   * and the enum column still get updated, but Twilio's `smsUrl`, `voiceUrl`,
   * and `statusCallback` are preserved exactly.
   *
   * Purpose: metadata-only normalization for legacy BYO TPN rows (created
   * before Wave-2 PR 4 introduced `metadata.activeChannels`/`capabilities`).
   * The number's carrier capabilities are verified via a live Twilio SID
   * fetch before write — if metadata claims a channel Twilio doesn't
   * actually support, the request is rejected.
   *
   * Not for enabling inbound routing. Rewriting the Twilio voiceUrl is a
   * separate concern (needs its own inbound-agent rollout).
   */
  @IsBoolean()
  @IsOptional()
  preserveWebhooks?: boolean;
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
