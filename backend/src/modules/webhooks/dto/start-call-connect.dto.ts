import { IsString, IsOptional, IsIn, IsBoolean } from 'class-validator';

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

  /**
   * Bot number (E.164) to use as caller ID. Used to look up the per-account
   * CallConnect settings row. Required for multi-tenant isolation — without this,
   * settings lookup falls back to any row for the workspace (legacy behaviour).
   */
  @IsOptional()
  @IsString()
  fromNumberHint?: string;

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

  /** Per-session agent whisper message (pre-built by caller). Overrides settings.agentWhisperMessage. */
  @IsOptional()
  @IsString()
  agentWhisperMessage?: string;

  /** Per-session lead greeting message (pre-built by caller). Overrides settings.leadGreetingMessage. */
  @IsOptional()
  @IsString()
  leadGreetingMessage?: string;

  /** Per-session voicemail message (pre-built by caller, variables already substituted). Overrides settings.leadVoicemailMessage. */
  @IsOptional()
  @IsString()
  leadVoicemailMessage?: string;

  /** When true, record the agent leg (whisper + conversation) for debugging. Used by test calls. */
  @IsOptional()
  @IsBoolean()
  recordAgentLeg?: boolean;
}
