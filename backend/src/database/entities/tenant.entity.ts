import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  OneToMany,
} from 'typeorm';
import { TenantPhoneNumber } from './tenant-phone-number.entity';

export enum TenantStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  SUSPENDED = 'suspended',
}

@Entity('tenants')
@Index(['workspaceId', 'externalId'], { unique: true })
export class Tenant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Cross-service reference to Callio's workspace (plain UUID, no FK)
  @Column({ name: 'workspace_id' })
  @Index()
  workspaceId: string;

  @Column({ name: 'external_id' })
  externalId: string;

  @Column()
  name: string;

  @Column({
    type: 'enum',
    enum: TenantStatus,
    default: TenantStatus.ACTIVE,
  })
  status: TenantStatus;

  @Column({ name: 'webhook_url', type: 'text', nullable: true })
  webhookUrl?: string;

  @Column({ name: 'webhook_secret', type: 'text', nullable: true })
  webhookSecret?: string;

  /**
   * Wave-2 Voice Foundation Phase 1 (PR 2, 2026-07-12) — customer-configured
   * inbound voice endpoint. When populated, PR 3 will forward inbound Twilio
   * voice webhooks to this URL and relay the TwiML response back to Twilio.
   *
   * PR 2 only stores/reads via the tenant voice-webhook management API; no
   * runtime code path consumes this value until PR 3 lands. Do not conflate
   * with `webhookUrl` which continues to serve outbound event notifications.
   */
  @Column({ name: 'voice_inbound_url', type: 'text', nullable: true })
  voiceInboundUrl?: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  // Cross-app identity references (populated by business-identity module)
  @Column({ name: 'business_identity_id', nullable: true })
  businessIdentityId?: string;

  @Column({ name: 'product_workspace_id', nullable: true })
  productWorkspaceId?: string;

  @OneToMany(() => TenantPhoneNumber, (tpn) => tpn.tenant)
  phoneNumbers: TenantPhoneNumber[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
