import { IsString, IsOptional, IsIn } from 'class-validator';

export class StartCallConnectDto {
  @IsString()
  businessId: string;

  @IsString()
  leadId: string;

  @IsString()
  leadPhoneE164: string;

  @IsOptional()
  @IsString()
  leadSummary?: string;

  /** Agent phone or owner ID hint; overrides settings.agentPhoneE164 if provided */
  @IsOptional()
  @IsString()
  agentHint?: string;

  @IsOptional()
  @IsString()
  source?: string;

  @IsOptional()
  @IsIn(['AGENT_FIRST', 'PARALLEL'])
  requestedMode?: 'AGENT_FIRST' | 'PARALLEL';

  /** Optional link to an existing Sigcore conversation thread */
  @IsOptional()
  @IsString()
  sigcoreConversationId?: string;

  /** Whisper message read to the agent. Supports {summary} placeholder. */
  @IsOptional()
  @IsString()
  agentWhisperMessage?: string;

  /** Greeting message read to the lead while waiting for the agent. */
  @IsOptional()
  @IsString()
  leadGreetingMessage?: string;
}
