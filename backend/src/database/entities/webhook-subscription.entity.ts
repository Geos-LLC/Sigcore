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
  CALL_INBOUND = 'call.inbound',
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
  // WhatsApp events
  WHATSAPP_MESSAGE_INBOUND = 'whatsapp.message.inbound',
  WHATSAPP_MESSAGE_OUTBOUND = 'whatsapp.message.outbound',
  WHATSAPP_MESSAGE_DELIVERED = 'whatsapp.message.delivered',
  WHATSAPP_STATUS_CHANGE = 'whatsapp.status.change',
  // Telegram events (Bot API connector — issue #1)
  TELEGRAM_MESSAGE_RECEIVED = 'telegram.message.received',
  TELEGRAM_MESSAGE_SENT = 'telegram.message.sent',
  TELEGRAM_MESSAGE_FAILED = 'telegram.message.failed',
  TELEGRAM_CONVERSATION_UPDATED = 'telegram.conversation.updated',
  TELEGRAM_ACCOUNT_CONNECTED = 'telegram.account.connected',
  TELEGRAM_ACCOUNT_DISCONNECTED = 'telegram.account.disconnected',
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

  /** Tenant scope — when set, only events for this tenant are delivered */
  @Column({ name: 'tenant_id', nullable: true })
  @Index()
  tenantId?: string;

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

  /**
   * Optional scope — when populated, the subscription receives only events
   * for this profile / business. Additive fan-out: profile- AND
   * business- AND tenant-scoped subscriptions all fire for matching events.
   */
  @Column({ name: 'communication_business_id', type: 'uuid', nullable: true })
  @Index()
  communicationBusinessId?: string;

  @Column({ name: 'communication_profile_id', type: 'uuid', nullable: true })
  @Index()
  communicationProfileId?: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
