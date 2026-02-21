import { IsString, IsOptional } from 'class-validator';

export class SendMessageDto {
  @IsString()
  businessId: string;

  @IsOptional()
  @IsString()
  leadId?: string;

  @IsString()
  toPhone: string;

  @IsString()
  body: string;

  @IsOptional()
  @IsString()
  automationId?: string;

  @IsOptional()
  @IsString()
  source?: string;
}
