import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * Cache of OpenPhone /contacts data per (tenant, phone).
 * Sigcore-owned, provider-truth mirror — never tenant-writable.
 * See plans/SIGCORE_OPENPHONE_CORRELATION.md §4.1.
 */
@Entity('openphone_contact_snapshot')
@Index(['workspaceId', 'providerAccountId', 'phoneE164'], { unique: true })
@Index(['workspaceId', 'phoneLast10'])
@Index(['workspaceId', 'providerContactId'])
@Index(['providerUpdatedAt'])
export class OpenPhoneContactSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'workspace_id' })
  workspaceId: string;

  @Column({ name: 'tenant_id', type: 'varchar', nullable: true })
  tenantId?: string;

  @Column({ name: 'provider_account_id', default: '' })
  providerAccountId: string;

  @Column({ name: 'phone_e164' })
  phoneE164: string;

  @Column({ name: 'phone_last10' })
  phoneLast10: string;

  @Column({ name: 'provider_contact_id', nullable: true })
  providerContactId?: string;

  @Column({ name: 'provider_first_name', nullable: true })
  providerFirstName?: string;

  @Column({ name: 'provider_last_name', nullable: true })
  providerLastName?: string;

  @Column({ name: 'provider_company', nullable: true })
  providerCompany?: string;

  @Column({ name: 'provider_updated_at', type: 'timestamptz', nullable: true })
  providerUpdatedAt?: Date;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
