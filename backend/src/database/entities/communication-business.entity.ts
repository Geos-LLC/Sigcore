import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
  OneToMany,
} from 'typeorm';
import { Tenant } from './tenant.entity';
import { CommunicationProfile } from './communication-profile.entity';

export enum CommunicationBusinessStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  SUSPENDED = 'suspended',
}

/**
 * Customer location / business identity under a tenant.
 *
 * Sits between Tenant and CommunicationProfile in the ID-based hierarchy:
 *   Workspace → Tenant → CommunicationBusiness → CommunicationProfile → ...
 *
 * external_business_id holds the upstream stable id when available — for
 * LeadBridge tenants this is the LB SavedAccountId; for Thumbtack it would
 * be the Thumbtack location id; etc. Names are display-only.
 */
@Entity('communication_businesses')
@Index(['tenantId', 'slug'], { unique: true })
@Index(['tenantId', 'externalBusinessId'], {
  unique: true,
  where: '"external_business_id" IS NOT NULL',
})
export class CommunicationBusiness {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'workspace_id', type: 'uuid' })
  @Index()
  workspaceId: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  @Index()
  tenantId: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant?: Tenant;

  /** Stable upstream id (LB savedAccountId, Thumbtack location id, etc.). NULL when unknown. */
  @Column({ name: 'external_business_id', type: 'text', nullable: true })
  externalBusinessId?: string;

  /** Display label only — must not be used for routing. */
  @Column({ name: 'display_name', type: 'text' })
  displayName: string;

  /** Stable, kebab-case, includes 8-char id suffix. Unique per tenant. */
  @Column({ type: 'text' })
  slug: string;

  @Column({ type: 'varchar', length: 32, default: 'active' })
  status: CommunicationBusinessStatus | string;

  /** FK to communication_profiles.id. Used for outbound fallback when a profile has no phone. */
  @Column({ name: 'default_profile_id', type: 'uuid', nullable: true })
  defaultProfileId?: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => CommunicationProfile, (p) => p.business)
  profiles?: CommunicationProfile[];
}
