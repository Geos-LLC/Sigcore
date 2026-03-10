import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Unique,
} from 'typeorm';

export enum CallConnectMode {
  AGENT_FIRST = 'AGENT_FIRST',
  PARALLEL = 'PARALLEL',
}

export enum AgentStrategy {
  OWNER = 'OWNER',
  ROUND_ROBIN = 'ROUND_ROBIN',
  ON_DUTY = 'ON_DUTY',
}

export enum CallerIdStrategy {
  BOT_NUMBER = 'BOT_NUMBER',
  BUSINESS_NUMBER = 'BUSINESS_NUMBER',
}

export enum AgentVoicemailMode {
  /** Play the configured TTS message (default). Agent call is released immediately. */
  TTS = 'TTS',
  /** Bridge the agent into the voicemail call so they can leave a personal message. */
  SPEAK = 'SPEAK',
}

/**
 * CallConnect settings — tenant-scoped.
 * One row per (workspaceId, businessId) pair.
 * workspaceId = Sigcore platform workspace (from API-key auth guard)
 * businessId  = LeadBridge savedAccountId — per-account identifier sent in request body
 *
 * Multiple LeadBridge accounts that share the same Sigcore workspace
 * (platform API key) each get their own isolated settings row.
 */
@Entity('call_connect_settings')
@Unique(['workspaceId', 'businessId'])
export class CallConnectSettings {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Sigcore platform workspace ID — resolved from API key by auth guard */
  @Column({ name: 'workspace_id' })
  workspaceId: string;

  /** LeadBridge per-account identifier (savedAccountId). One row per account. */
  @Column({ name: 'business_id' })
  businessId: string;

  @Column({ default: false })
  enabled: boolean;

  @Column({
    type: 'enum',
    enum: CallConnectMode,
    default: CallConnectMode.AGENT_FIRST,
  })
  mode: CallConnectMode;

  @Column({ name: 'ring_timeout_seconds', type: 'int', default: 60 })
  ringTimeoutSeconds: number;

  @Column({ name: 'agent_accept_digits', default: '1' })
  agentAcceptDigits: string;

  @Column({ name: 'max_agent_attempts', type: 'int', default: 2 })
  maxAgentAttempts: number;

  @Column({
    name: 'agent_strategy',
    type: 'enum',
    enum: AgentStrategy,
    default: AgentStrategy.OWNER,
  })
  agentStrategy: AgentStrategy;

  @Column({ name: 'lead_retry_policy', type: 'jsonb', nullable: true })
  leadRetryPolicy: Record<string, unknown>;

  @Column({ name: 'quiet_hours', type: 'jsonb', nullable: true })
  quietHours: Record<string, unknown>;

  @Column({
    name: 'caller_id_strategy',
    type: 'enum',
    enum: CallerIdStrategy,
    default: CallerIdStrategy.BOT_NUMBER,
  })
  callerIdStrategy: CallerIdStrategy;

  /** Shared bot number used as caller ID (default tier) */
  @Column({ name: 'bot_number_e164', nullable: true })
  botNumberE164: string;

  /** Per-business number used for higher tiers */
  @Column({ name: 'business_number_e164', nullable: true })
  businessNumberE164: string;

  /** MVP: single static agent phone. Future: resolve via agentStrategy. */
  @Column({ name: 'agent_phone_e164', nullable: true })
  agentPhoneE164: string;

  /**
   * Custom TTS message spoken to the agent when they pick up.
   * Supports {summary} and {digit} placeholders.
   * Default: "You have a new lead: {summary}. Press {digit} to connect."
   */
  @Column({ name: 'agent_whisper_message', type: 'text', nullable: true })
  agentWhisperMessage: string;

  /**
   * Custom TTS message spoken to the lead when they answer and wait for bridge.
   * Default: "Please hold while we connect you."
   */
  @Column({ name: 'lead_greeting_message', type: 'text', nullable: true })
  leadGreetingMessage: string;

  /** Enable automatic voicemail drop when lead doesn't answer */
  @Column({ name: 'lead_voicemail_enabled', default: false })
  leadVoicemailEnabled: boolean;

  /**
   * TTS message to leave on lead voicemail if they don't answer.
   * Only used when leadVoicemailEnabled is true and leadVoicemailRecordingUrl is not set.
   */
  @Column({ name: 'lead_voicemail_message', type: 'text', nullable: true })
  leadVoicemailMessage: string;

  /**
   * URL of a pre-recorded audio file (MP3/WAV) to play on the lead voicemail.
   * When set, takes priority over leadVoicemailMessage (TTS).
   * Must be a publicly accessible HTTPS URL.
   */
  @Column({ name: 'lead_voicemail_recording_url', type: 'text', nullable: true })
  leadVoicemailRecordingUrl: string;

  /**
   * How the voicemail message is delivered when leadVoicemailEnabled is true.
   * TTS (default): agent is released, configured text is read by TTS.
   * SPEAK: agent is kept on the line and bridged into the voicemail call to speak personally.
   */
  @Column({
    name: 'agent_voicemail_mode',
    type: 'enum',
    enum: AgentVoicemailMode,
    default: AgentVoicemailMode.TTS,
  })
  agentVoicemailMode: AgentVoicemailMode;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
