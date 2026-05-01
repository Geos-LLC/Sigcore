import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { CommunicationProfile } from './communication-profile.entity';
import { TenantPhoneNumber } from './tenant-phone-number.entity';

export enum AssignmentRole {
  PRIMARY = 'primary',
  FALLBACK = 'fallback',
  INBOUND_ONLY = 'inbound_only',
  OUTBOUND_ONLY = 'outbound_only',
  REPLY = 'reply',
}

/**
 * M:N junction between communication_profiles and tenant_phone_numbers.
 *
 * One phone can serve multiple profiles (Thumbtack and Yelp share a number)
 * and one profile can hold multiple phones (primary + fallback). A profile's
 * outbound default is the row with is_default = TRUE; inbound resolution
 * orders by (is_default DESC, priority DESC) when a sticky conversation
 * doesn't already determine the profile.
 */
@Entity('profile_phone_assignments')
@Index(['profileId', 'tenantPhoneNumberId'], { unique: true })
@Index(['profileId'], {
  unique: true,
  where: '"is_default" = TRUE AND "active" = TRUE',
})
@Index(['tenantPhoneNumberId', 'active'])
export class ProfilePhoneAssignment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'profile_id', type: 'uuid' })
  @Index()
  profileId: string;

  @ManyToOne(() => CommunicationProfile, (p) => p.phoneAssignments, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'profile_id' })
  profile?: CommunicationProfile;

  @Column({ name: 'tenant_phone_number_id', type: 'uuid' })
  tenantPhoneNumberId: string;

  @ManyToOne(() => TenantPhoneNumber, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_phone_number_id' })
  tenantPhoneNumber?: TenantPhoneNumber;

  /** primary | fallback | inbound_only | outbound_only | reply */
  @Column({ type: 'varchar', length: 32, default: 'primary' })
  role: AssignmentRole | string;

  /** Exactly one default per profile when active (partial-unique index). */
  @Column({ name: 'is_default', type: 'boolean', default: false })
  isDefault: boolean;

  /** Higher wins for outbound. Tie-broken by is_default first. */
  @Column({ type: 'integer', default: 100 })
  priority: number;

  @Column({ type: 'boolean', default: true })
  active: boolean;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
