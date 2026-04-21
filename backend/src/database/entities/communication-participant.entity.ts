import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * Canonical communication identity — provider-agnostic by design.
 * A participant is a phone-based communication endpoint as Sigcore sees it,
 * NOT a person. Cross-provider person-merging is out of scope for this phase.
 *
 * See plans/SIGCORE_OPENPHONE_CORRELATION.md §4.2.
 */
@Entity('communication_participants')
@Index(
  ['workspaceId', 'tenantId', 'provider', 'providerAccountId', 'normalizedPhoneE164'],
  { unique: true },
)
@Index(['participantKey'])
@Index(['workspaceId', 'tenantId', 'provider', 'providerContactId'])
@Index(['workspaceId', 'tenantId', 'normalizedPhoneE164'])
export class CommunicationParticipant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'workspace_id' })
  workspaceId: string;

  @Column({ name: 'tenant_id' })
  tenantId: string;

  @Column()
  provider: string; // 'openphone' today

  @Column({ name: 'provider_account_id', default: '' })
  providerAccountId: string; // '' sentinel when unknown — keeps unique index sound

  @Column({ name: 'participant_key', type: 'text' })
  participantKey: string; // 'openphone:<tenant_id>:<provider_account_id>:<phone_e164>'

  @Column({ name: 'normalized_phone_e164' })
  normalizedPhoneE164: string;

  @Column({ name: 'raw_phone', nullable: true })
  rawPhone?: string;

  @Column({ name: 'provider_contact_id', nullable: true })
  providerContactId?: string;

  @Column({ name: 'provider_display_name', nullable: true })
  providerDisplayName?: string;

  @Column({ name: 'provider_company', nullable: true })
  providerCompany?: string;

  @Column({ name: 'first_seen_at', type: 'timestamptz' })
  firstSeenAt: Date;

  @Column({ name: 'last_seen_at', type: 'timestamptz' })
  lastSeenAt: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
