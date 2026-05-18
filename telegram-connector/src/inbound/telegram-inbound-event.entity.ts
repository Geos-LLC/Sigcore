import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type InboundEventStatus = 'pending' | 'processing' | 'sent' | 'failed' | 'dead';

/**
 * Durable inbound-event row backing the connector's retry-safe ingest
 * pipeline. Stored in Postgres so:
 *   - state survives connector restarts (no disk loss)
 *   - the drainer can use SELECT ... FOR UPDATE SKIP LOCKED for
 *     single-flight processing across replicas
 *   - the table lives in shared infrastructure visible to operations.
 */
@Entity('telegram_inbound_events')
@Index(['tenantId', 'accountId', 'externalMessageId'], { unique: true })
@Index(['status', 'nextAttemptAt'])
export class TelegramInboundEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ name: 'account_id', type: 'uuid' })
  accountId: string;

  @Column({ type: 'text', default: 'telegram' })
  provider: string;

  @Column({ name: 'external_message_id', type: 'text' })
  externalMessageId: string;

  @Column({ name: 'external_conversation_id', type: 'text' })
  externalConversationId: string;

  @Column({ name: 'participant_key', type: 'text' })
  participantKey: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ name: 'normalized_payload', type: 'jsonb' })
  normalizedPayload: Record<string, unknown>;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status: InboundEventStatus;

  @Column({ type: 'int', default: 0 })
  attempts: number;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError?: string;

  @Column({ name: 'next_attempt_at', type: 'timestamp', nullable: true })
  nextAttemptAt?: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
