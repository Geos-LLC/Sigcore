import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { CallConnectMode } from './call-connect-settings.entity';

export enum SessionStatus {
  CREATED = 'CREATED',
  CALLING_AGENT = 'CALLING_AGENT',
  AGENT_ANSWERED = 'AGENT_ANSWERED',
  AGENT_ACCEPTED = 'AGENT_ACCEPTED',
  CALLING_LEAD = 'CALLING_LEAD',
  LEAD_ANSWERED = 'LEAD_ANSWERED',
  BRIDGED = 'BRIDGED',
  ENDED = 'ENDED',
  FAILED = 'FAILED',
  CANCELED = 'CANCELED',
}

export enum CallConnectProvider {
  TWILIO = 'TWILIO',
}

@Entity('call_connect_sessions')
@Index(['businessId', 'leadId'], { unique: true }) // idempotency: one session per lead per business
export class CallConnectSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'business_id' })
  @Index()
  businessId: string;

  /** Tenant UUID — populated when auth is via a tenant-scoped API key */
  @Column({ name: 'tenant_id', nullable: true })
  tenantId: string;

  @Column({ name: 'lead_id' })
  leadId: string;

  @Column({ name: 'lead_phone_e164' })
  leadPhoneE164: string;

  @Column({ name: 'lead_summary', type: 'text', nullable: true })
  leadSummary: string;

  @Column({ name: 'agent_id', nullable: true })
  agentId: string;

  @Column({ name: 'agent_phone_e164', nullable: true })
  agentPhoneE164: string;

  @Column({ type: 'enum', enum: CallConnectMode })
  mode: CallConnectMode;

  @Column({
    type: 'enum',
    enum: SessionStatus,
    default: SessionStatus.CREATED,
  })
  status: SessionStatus;

  @Column({
    type: 'enum',
    enum: CallConnectProvider,
    default: CallConnectProvider.TWILIO,
  })
  provider: CallConnectProvider;

  @Column({ name: 'from_number_e164' })
  fromNumberE164: string;

  /** Twilio CallSid for the agent leg */
  @Column({ name: 'agent_call_sid', nullable: true })
  @Index()
  agentCallSid: string;

  /** Twilio CallSid for the lead leg */
  @Column({ name: 'lead_call_sid', nullable: true })
  @Index()
  leadCallSid: string;

  @Column({ name: 'conference_name', nullable: true })
  conferenceName: string;

  @Column({ type: 'int', default: 1 })
  attempt: number;

  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason: string;

  @Column({ name: 'recording_url', nullable: true })
  recordingUrl: string;

  /** Per-session agent whisper (pre-built by caller). Overrides settings.agentWhisperMessage when set. */
  @Column({ name: 'agent_whisper_message', type: 'text', nullable: true })
  agentWhisperMessage: string;

  /** Per-session lead greeting (pre-built by caller). Overrides settings.leadGreetingMessage when set. */
  @Column({ name: 'lead_greeting_message', type: 'text', nullable: true })
  leadGreetingMessage: string;

  /** Per-session voicemail message (pre-built by caller). Overrides settings.leadVoicemailMessage when set. */
  @Column({ name: 'lead_voicemail_message', type: 'text', nullable: true })
  leadVoicemailMessage: string;

  /** Linked Sigcore conversation thread (nullable — not all sessions have one) */
  @Column({ name: 'sigcore_conversation_id', type: 'uuid', nullable: true })
  sigcoreConversationId: string;

  /** When true, record the agent leg for debugging (not persisted — set per-session in memory) */
  @Column({ name: 'record_agent_leg', type: 'boolean', default: false })
  recordAgentLeg: boolean;

  /**
   * When true, skip the whisper + DTMF Gather on the agent leg and drop the
   * agent leg directly into the conference. Set by callers routing to a voice AI
   * that answers with speech and can't press a DTMF digit.
   */
  @Column({ name: 'skip_agent_whisper', type: 'boolean', default: false })
  skipAgentWhisper: boolean;

  /** Append-only audit trail of state transitions */
  @Column({ type: 'jsonb', default: [] })
  timeline: Array<Record<string, unknown>>;

  /**
   * Incident 2026-07-14 — per-number → integration ownership repair.
   *
   * Owning Twilio integration for this Call Connect session (agent + lead
   * legs share the same provider account). Nullable for legacy rows.
   */
  @Column({ name: 'communication_integration_id', type: 'uuid', nullable: true })
  @Index()
  communicationIntegrationId?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
