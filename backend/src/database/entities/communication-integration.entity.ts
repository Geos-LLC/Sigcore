import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum IntegrationStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  ERROR = 'error',
}

export enum ProviderType {
  OPENPHONE = 'openphone',
  TWILIO = 'twilio',
  WHATSAPP = 'whatsapp',
  TELEGRAM = 'telegram',
}

@Entity('communication_integrations')
@Index(['workspaceId', 'provider'], { unique: true })
export class CommunicationIntegration {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'workspace_id' })
  @Index()
  workspaceId: string;

  @Column({
    type: 'enum',
    enum: ProviderType,
    default: ProviderType.OPENPHONE,
  })
  provider: ProviderType;

  @Column({ name: 'credentials_encrypted', type: 'text' })
  credentialsEncrypted: string;

  @Column({ name: 'webhook_secret_encrypted', type: 'text', nullable: true })
  webhookSecretEncrypted?: string;

  @Column({ name: 'external_workspace_id', nullable: true })
  externalWorkspaceId?: string;

  @Column({
    type: 'enum',
    enum: IntegrationStatus,
    default: IntegrationStatus.ACTIVE,
  })
  status: IntegrationStatus;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
