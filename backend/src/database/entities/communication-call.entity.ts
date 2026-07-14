import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { CommunicationConversation } from './communication-conversation.entity';

export enum CallDirection {
  IN = 'in',
  OUT = 'out',
}

export enum CallStatus {
  COMPLETED = 'completed',
  MISSED = 'missed',
  VOICEMAIL = 'voicemail',
  CANCELLED = 'cancelled',
}

@Entity('communication_calls')
export class CommunicationCall {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'conversation_id' })
  @Index()
  conversationId: string;

  @Column({
    type: 'enum',
    enum: CallDirection,
  })
  direction: CallDirection;

  @Column({ type: 'int', default: 0 })
  duration: number;

  @Column({ name: 'recording_url', nullable: true })
  recordingUrl: string;

  @Column({ name: 'voicemail_url', nullable: true })
  voicemailUrl: string;

  @Column({ name: 'from_number' })
  fromNumber: string;

  @Column({ name: 'to_number' })
  toNumber: string;

  @Column({ name: 'provider_call_id', nullable: true })
  @Index()
  providerCallId: string;

  @Column({
    type: 'enum',
    enum: CallStatus,
    default: CallStatus.COMPLETED,
  })
  status: CallStatus;

  @Column({ name: 'initiated_by_user_id', nullable: true })
  @Index()
  initiatedByUserId: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown>;

  @Column({ type: 'text', nullable: true })
  transcript: string;

  @Column({ name: 'transcript_status', nullable: true })
  transcriptStatus: string;

  @Column({ name: 'local_recording_path', nullable: true })
  localRecordingPath: string;

  @Column({ name: 'local_voicemail_path', nullable: true })
  localVoicemailPath: string;

  /**
   * Incident 2026-07-14 — per-number → integration ownership repair.
   *
   * Stamped by call-persistence code paths so ProviderContextResolver's
   * rule 2 (`by_stamped_resource`) can resolve `providerCallId` -> owning
   * integration without falling back to `metadata.integrationId`.
   */
  @Column({ name: 'communication_integration_id', type: 'uuid', nullable: true })
  @Index()
  communicationIntegrationId?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @Column({ name: 'started_at', nullable: true })
  startedAt: Date;

  @Column({ name: 'ended_at', nullable: true })
  endedAt: Date;

  @ManyToOne(() => CommunicationConversation, (conv) => conv.calls)
  @JoinColumn({ name: 'conversation_id' })
  conversation: CommunicationConversation;
}
