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

  /** Append-only audit trail of state transitions */
  @Column({ type: 'jsonb', default: [] })
  timeline: Array<Record<string, unknown>>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
