import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
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

@Entity('call_connect_settings')
export class CallConnectSettings {
  /** Primary key = workspaceId (one row per business) */
  @PrimaryColumn({ name: 'business_id' })
  businessId: string;

  @Column({ default: false })
  enabled: boolean;

  @Column({
    type: 'enum',
    enum: CallConnectMode,
    default: CallConnectMode.AGENT_FIRST,
  })
  mode: CallConnectMode;

  @Column({ name: 'ring_timeout_seconds', type: 'int', default: 20 })
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
   * Only used when leadVoicemailEnabled is true.
   */
  @Column({ name: 'lead_voicemail_message', type: 'text', nullable: true })
  leadVoicemailMessage: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
