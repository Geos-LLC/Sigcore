import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type TelegramPlacementStatus =
  | 'queued'
  | 'scheduled'
  | 'sent'
  | 'failed'
  | 'cancelled';

@Entity('telegram_placements')
@Index(['workspaceId', 'externalRef'], { unique: true })
@Index(['workspaceId', 'status'])
@Index(['teleporterMessageId'])
export class TelegramPlacement {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'workspace_id', type: 'uuid' })
  workspaceId: string;

  @Column({ name: 'tenant_id', type: 'uuid', nullable: true })
  tenantId?: string;

  @Column({ name: 'chat_ref', type: 'varchar', length: 255 })
  chatRef: string;

  @Column({ type: 'text', nullable: true })
  text?: string;

  @Column({ name: 'image_url', type: 'text', nullable: true })
  imageUrl?: string;

  @Column({ name: 'parse_mode', type: 'varchar', length: 16, nullable: true })
  parseMode?: 'Markdown' | 'HTML' | null;

  @Column({ name: 'scheduled_at', type: 'timestamptz', nullable: true })
  scheduledAt?: Date;

  @Column({ name: 'external_ref', type: 'varchar', length: 255 })
  externalRef: string;

  @Column({ name: 'teleporter_message_id', type: 'varchar', length: 128, nullable: true })
  teleporterMessageId?: string;

  @Column({ type: 'varchar', length: 32, default: 'queued' })
  status: TelegramPlacementStatus;

  @Column({ name: 'provider_message_id', type: 'varchar', length: 128, nullable: true })
  providerMessageId?: string;

  @Column({ name: 'error_code', type: 'varchar', length: 64, nullable: true })
  errorCode?: string;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage?: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @Column({ name: 'sent_at', type: 'timestamptz', nullable: true })
  sentAt?: Date;
}
