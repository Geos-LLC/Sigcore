import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum SmsDirection {
  OUTBOUND = 'OUTBOUND',
  INBOUND = 'INBOUND',
}

export enum SmsStatus {
  QUEUED = 'queued',
  SENT = 'sent',
  DELIVERED = 'delivered',
  UNDELIVERED = 'undelivered',
  FAILED = 'failed',
  RECEIVED = 'received',
}

@Entity('sms_messages')
@Index(['businessId', 'createdAt'])
export class SmsMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'business_id' })
  @Index()
  businessId: string;

  /** LeadBridge lead ID — nullable for replies not tied to a known lead */
  @Column({ name: 'lead_id', type: 'text', nullable: true })
  leadId?: string;

  @Column({ type: 'enum', enum: SmsDirection })
  direction: SmsDirection;

  @Column({ name: 'from_number', type: 'text' })
  fromNumber: string;

  @Column({ name: 'to_number', type: 'text' })
  toNumber: string;

  @Column({ type: 'text' })
  body: string;

  @Column({ type: 'enum', enum: SmsStatus, default: SmsStatus.QUEUED })
  status: SmsStatus;

  @Column({ name: 'provider_sid', type: 'text', nullable: true })
  @Index()
  providerSid?: string;

  @Column({ name: 'error_code', type: 'text', nullable: true })
  errorCode?: string;

  @Column({ type: 'decimal', precision: 10, scale: 5, nullable: true })
  price?: number;

  @Column({ name: 'automation_id', type: 'text', nullable: true })
  automationId?: string;

  @Column({ type: 'text', nullable: true })
  source?: string;

  /**
   * Incident 2026-07-14 — per-number → integration ownership repair.
   *
   * Owning provider integration for the outbound/inbound SMS. Stamped by
   * send/receive paths so downstream ProviderContextResolver rule 2
   * (`by_stamped_resource`) resolves deterministically.
   */
  @Column({ name: 'communication_integration_id', type: 'uuid', nullable: true })
  @Index()
  communicationIntegrationId?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
