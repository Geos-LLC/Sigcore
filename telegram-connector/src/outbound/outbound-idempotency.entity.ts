import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * DB-backed outbound idempotency cache. Replaces the prior disk LRU.
 *
 * Uniqueness on (tenantId, accountId, idempotencyKey) means even concurrent
 * retries of the same outbound send under the same idempotencyKey resolve
 * to the same provider message id — no double-send.
 */
@Entity('telegram_outbound_idempotency')
@Index(['tenantId', 'accountId', 'idempotencyKey'], { unique: true })
export class TelegramOutboundIdempotency {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ name: 'account_id', type: 'uuid' })
  accountId: string;

  @Column({ name: 'idempotency_key', type: 'text' })
  idempotencyKey: string;

  @Column({ name: 'external_message_id', type: 'text' })
  externalMessageId: string;

  @Column({ type: 'varchar', length: 16 })
  status: 'sent' | 'queued' | 'failed';

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
