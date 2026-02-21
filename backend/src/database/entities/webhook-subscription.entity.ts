import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum WebhookEventType {
  MESSAGE_SENT = 'message.sent',
  MESSAGE_DELIVERED = 'message.delivered',
  MESSAGE_FAILED = 'message.failed',
  MESSAGE_INBOUND = 'message.inbound',
  CALL_STARTED = 'call.started',
  CALL_COMPLETED = 'call.completed',
  CALL_MISSED = 'call.missed',
  // Call Connect events (Instant Call Bridge for LeadBridge)
  CALL_CONNECT_SESSION_CREATED = 'call_connect.session.created',
  CALL_CONNECT_AGENT_RINGING = 'call_connect.agent.ringing',
  CALL_CONNECT_AGENT_ACCEPTED = 'call_connect.agent.accepted',
  CALL_CONNECT_LEAD_RINGING = 'call_connect.lead.ringing',
  CALL_CONNECT_BRIDGED = 'call_connect.bridged',
  CALL_CONNECT_VOICEMAIL_DROP = 'call_connect.voicemail_drop',
  CALL_CONNECT_ENDED = 'call_connect.ended',
  CALL_CONNECT_FAILED = 'call_connect.failed',
  // SMS messaging events (LeadBridge two-way SMS)
  SMS_MESSAGE_RECEIVED = 'sms.message.received',
  SMS_MESSAGE_DELIVERED = 'sms.message.delivered',
  SMS_MESSAGE_FAILED = 'sms.message.failed',
}

export enum WebhookSubscriptionStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  PAUSED = 'paused',
}

@Entity('webhook_subscriptions')
@Index(['workspaceId', 'status'])
export class WebhookSubscription {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'workspace_id' })
  @Index()
  workspaceId: string;

  @Column({ type: 'text' })
  name: string;

  @Column({ name: 'webhook_url', type: 'text' })
  webhookUrl: string;

  @Column({ name: 'secret', type: 'text', nullable: true })
  secret?: string;

  @Column({ type: 'simple-array' })
  events: WebhookEventType[];

  @Column({
    type: 'enum',
    enum: WebhookSubscriptionStatus,
    default: WebhookSubscriptionStatus.ACTIVE,
  })
  status: WebhookSubscriptionStatus;

  @Column({ name: 'failure_count', type: 'int', default: 0 })
  failureCount: number;

  @Column({ name: 'last_success_at', type: 'timestamp', nullable: true })
  lastSuccessAt?: Date;

  @Column({ name: 'last_failure_at', type: 'timestamp', nullable: true })
  lastFailureAt?: Date;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError?: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
