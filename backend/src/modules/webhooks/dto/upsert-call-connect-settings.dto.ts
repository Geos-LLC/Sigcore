import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { CallConnectMode, AgentStrategy, CallerIdStrategy, AgentVoicemailMode } from '../../../database/entities/call-connect-settings.entity';

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

  /** Custom whisper to agent. Supports {summary} and {digit} placeholders. */
  @IsOptional()
  @IsString()
  agentWhisperMessage?: string;

  /** Custom TTS greeting for the lead leg. */
  @IsOptional()
  @IsString()
  leadGreetingMessage?: string;

  /** Enable automatic voicemail drop when lead doesn't answer. */
  @IsOptional()
  @IsBoolean()
  leadVoicemailEnabled?: boolean;

  /** Message to leave on lead voicemail (requires leadVoicemailEnabled=true). */
  @IsOptional()
  @IsString()
  leadVoicemailMessage?: string;

  /**
   * How the voicemail is delivered.
   * TTS (default): agent released, configured text is read by TTS.
   * SPEAK: agent is bridged into the voicemail call to leave a personal message.
   */
  @IsOptional()
  @IsEnum(AgentVoicemailMode)
  agentVoicemailMode?: AgentVoicemailMode;
}
