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
import { CommunicationBusiness } from './communication-business.entity';
import { ProfilePhoneAssignment } from './profile-phone-assignment.entity';

/**
 * Source channel a profile lives on. App-layer validated only — there is
 * no DB CHECK constraint, so adding a new source doesn't require a
 * migration. Keep this list in sync with source-classifier.ts.
 */
export enum ProfileSource {
  LEADBRIDGE = 'leadbridge',
  HIREFUNNEL = 'hirefunnel',
  SERVICEFLOW = 'serviceflow',
  CALLIO = 'callio',
  THUMBTACK = 'thumbtack',
  YELP = 'yelp',
  FACEBOOK = 'facebook',
  CRAIGSLIST = 'craigslist',
  INDEED = 'indeed',
  MANUAL = 'manual',
  INTERNAL = 'internal',
}

export enum ProfileStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  SUSPENDED = 'suspended',
}

/**
 * Source-bound communication identity under a business.
 *
 * Examples:
 *   business "Spotless Homes Tampa" → profile "Thumbtack Tampa" + profile "Yelp Tampa"
 *   business "HireFunnel"           → profile "Reminders"
 *
 * Profiles are the unit of routing — phones, conversations, webhook
 * subscriptions, and outbound sends all reference profile_id.
 */
@Entity('communication_profiles')
@Index(['communicationBusinessId', 'slug'], { unique: true })
@Index(['communicationBusinessId', 'source', 'externalProfileId'], {
  unique: true,
  where: '"external_profile_id" IS NOT NULL',
})
@Index(['communicationBusinessId'], {
  unique: true,
  where: '"is_default" = TRUE',
})
export class CommunicationProfile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Denormalized for fast scoping queries. Always equals tenant.workspace_id. */
  @Column({ name: 'workspace_id', type: 'uuid' })
  @Index()
  workspaceId: string;

  /** Denormalized for fast scoping queries. Always equals business.tenant_id. */
  @Column({ name: 'tenant_id', type: 'uuid' })
  @Index()
  tenantId: string;

  @Column({ name: 'communication_business_id', type: 'uuid' })
  @Index()
  communicationBusinessId: string;

  @ManyToOne(() => CommunicationBusiness, (b) => b.profiles, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'communication_business_id' })
  business?: CommunicationBusiness;

  /** Channel the profile lives on. Validated app-side, see ProfileSource. */
  @Column({ type: 'varchar', length: 32 })
  source: ProfileSource | string;

  /** Stable upstream id under the source (Thumbtack account id, Yelp profile id, …). */
  @Column({ name: 'external_profile_id', type: 'text', nullable: true })
  externalProfileId?: string;

  /** Display label only — never used for routing. */
  @Column({ name: 'display_name', type: 'text' })
  displayName: string;

  /** Stable, kebab-case, unique per (communication_business_id, slug). */
  @Column({ type: 'text' })
  slug: string;

  @Column({ type: 'varchar', length: 32, default: 'active' })
  status: ProfileStatus | string;

  /** Exactly one profile per business has is_default = TRUE (partial-unique index). */
  @Column({ name: 'is_default', type: 'boolean', default: false })
  isDefault: boolean;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => ProfilePhoneAssignment, (a) => a.profile)
  phoneAssignments?: ProfilePhoneAssignment[];
}
