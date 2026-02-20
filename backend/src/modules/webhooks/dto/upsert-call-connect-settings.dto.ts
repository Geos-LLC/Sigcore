import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { CallConnectMode, AgentStrategy, CallerIdStrategy } from '../../../database/entities/call-connect-settings.entity';

export class UpsertCallConnectSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsEnum(CallConnectMode)
  mode?: CallConnectMode;

  @IsOptional()
  @IsInt()
  @Min(5)
  ringTimeoutSeconds?: number;

  @IsOptional()
  @IsString()
  agentAcceptDigits?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxAgentAttempts?: number;

  @IsOptional()
  @IsEnum(AgentStrategy)
  agentStrategy?: AgentStrategy;

  @IsOptional()
  leadRetryPolicy?: Record<string, unknown>;

  @IsOptional()
  quietHours?: Record<string, unknown>;

  @IsOptional()
  @IsEnum(CallerIdStrategy)
  callerIdStrategy?: CallerIdStrategy;

  @IsOptional()
  @IsString()
  botNumberE164?: string;

  @IsOptional()
  @IsString()
  businessNumberE164?: string;

  /** MVP: single agent phone number */
  @IsOptional()
  @IsString()
  agentPhoneE164?: string;
}
