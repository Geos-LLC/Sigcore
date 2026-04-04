import { IsString, IsOptional, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class RoutingContextDto {
  @IsString() @IsOptional()
  channel?: string; // 'sms' | 'voice' | 'email' | 'marketplace'

  @IsString() @IsOptional()
  provider?: string; // 'openphone' | 'twilio' | 'leadbridge'

  @IsString() @IsOptional()
  role_hint?: string; // 'leadbridge_assigned_number' | 'callio_main_inbox'

  @IsString() @IsOptional()
  purpose_hint?: string; // 'lead_capture' | 'main_business_line'

  @IsString() @IsOptional()
  product_type?: string; // filter to specific product
}

export class SelectRoutingDto {
  @IsArray()
  candidates: any[]; // CandidateWorkspace[] from identity resolution

  @ValidateNested()
  @Type(() => RoutingContextDto)
  context: RoutingContextDto;
}
