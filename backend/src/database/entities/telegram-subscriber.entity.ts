import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type TelegramSubscriberStatus = 'provisioning' | 'ready' | 'retired';
export type TelegramSubscriberMode = 'bot' | 'account';
export type TelegramLinkStatus =
  | 'code_requested'
  | 'password_required'
  | 'linked'
  | 'revoked';

@Entity('telegram_subscribers')
@Index(['workspaceId'])
@Index(['tenantId'])
export class TelegramSubscriber {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'workspace_id', type: 'uuid' })
  workspaceId: string;

  @Column({ name: 'tenant_id', type: 'uuid', nullable: true })
  tenantId?: string;

  @Column({ name: 'teleporter_subscriber_id', type: 'varchar', length: 128, nullable: true })
  teleporterSubscriberId?: string;

  @Column({ name: 'bot_username', type: 'varchar', length: 128, nullable: true })
  botUsername?: string;

  @Column({ name: 'invite_hint', type: 'text', nullable: true })
  inviteHint?: string;

  @Column({ type: 'varchar', length: 32, default: 'provisioning' })
  status: TelegramSubscriberStatus;

  @Column({ type: 'varchar', length: 16, default: 'bot' })
  mode: TelegramSubscriberMode;

  @Column({ name: 'tg_user_id', type: 'varchar', length: 64, nullable: true })
  tgUserId?: string;

  @Column({ name: 'tg_username', type: 'varchar', length: 128, nullable: true })
  tgUsername?: string;

  @Column({ name: 'link_account_id', type: 'varchar', length: 128, nullable: true })
  linkAccountId?: string;

  @Column({ name: 'link_status', type: 'varchar', length: 32, nullable: true })
  linkStatus?: TelegramLinkStatus;

  @Column({ name: 'provisioned_at', type: 'timestamptz', nullable: true })
  provisionedAt?: Date;

  @Column({ name: 'retired_at', type: 'timestamptz', nullable: true })
  retiredAt?: Date;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
