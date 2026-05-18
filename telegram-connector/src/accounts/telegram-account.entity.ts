import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type TelegramAccountMode = 'bot' | 'mtproto';
export type TelegramAccountStatus =
  | 'connected'
  | 'disconnected'
  | 'expired'
  | 'error';

@Entity('telegram_accounts')
@Index(['tenantId', 'id'])
export class TelegramAccount {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  @Index()
  tenantId: string;

  @Column({ type: 'text', default: 'telegram' })
  provider: string;

  @Column({ type: 'varchar', length: 16 })
  mode: TelegramAccountMode;

  @Column({ name: 'display_name', type: 'text', nullable: true })
  displayName?: string;

  @Column({ name: 'bot_username', type: 'text', nullable: true })
  botUsername?: string;

  // AES-256-GCM encrypted. Never stored raw, never logged.
  @Column({ name: 'bot_token_encrypted', type: 'text', nullable: true })
  botTokenEncrypted?: string;

  @Column({ name: 'gramjs_session_encrypted', type: 'text', nullable: true })
  gramjsSessionEncrypted?: string;

  @Column({ name: 'telegram_user_id', type: 'text', nullable: true })
  telegramUserId?: string;

  @Column({ type: 'text', nullable: true })
  phone?: string;

  @Column({ type: 'varchar', length: 16, default: 'disconnected' })
  status: TelegramAccountStatus;

  @Column({ name: 'last_connected_at', type: 'timestamp', nullable: true })
  lastConnectedAt?: Date;

  @Column({ name: 'last_ping_at', type: 'timestamp', nullable: true })
  lastPingAt?: Date;

  @Column({ name: 'reconnect_attempts', type: 'int', default: 0 })
  reconnectAttempts: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
