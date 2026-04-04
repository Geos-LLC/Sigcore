import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  OneToMany,
} from 'typeorm';
import { WorkspaceAssetLink } from './workspace-asset-link.entity';

export enum AssetType {
  PHONE = 'phone',
  EMAIL = 'email',
  PROVIDER_NUMBER = 'provider_number',
  PROVIDER_ACCOUNT = 'provider_account',
  INBOX_IDENTITY = 'inbox_identity',
}

export enum AssetStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

/**
 * Shared communication asset — a phone number, email, provider number, or account
 * that can be linked to multiple product workspaces.
 *
 * Uniqueness rules:
 * - Generic assets (phone, email): unique by (asset_type, normalized_value) — no provider constraint.
 *   The same phone number is ONE asset regardless of which provider routes it.
 * - Provider-specific assets (provider_number, provider_account, inbox_identity):
 *   unique by (asset_type, normalized_value, provider) — same number from different providers = different assets.
 *
 * This distinction is enforced via two partial unique indexes in the migration,
 * NOT a single composite unique constraint.
 */
@Entity('shared_communication_assets')
export class SharedCommunicationAsset {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    name: 'asset_type',
    type: 'enum',
    enum: AssetType,
  })
  assetType: AssetType;

  // E.164 for phones, lowercase for emails
  @Column({ name: 'normalized_value' })
  @Index()
  normalizedValue: string;

  @Column({ name: 'display_value', nullable: true })
  displayValue?: string;

  // Provider that owns/routes this asset: 'openphone', 'twilio', 'sendgrid', etc.
  // NULL for generic business phone/email not tied to a specific provider
  @Column({ nullable: true })
  provider?: string;

  // Provider's own ID for this asset (Twilio SID, OpenPhone phone number ID, etc.)
  @Column({ name: 'external_asset_id', nullable: true })
  @Index()
  externalAssetId?: string;

  @Column({
    type: 'enum',
    enum: AssetStatus,
    default: AssetStatus.ACTIVE,
  })
  status: AssetStatus;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => WorkspaceAssetLink, (wal) => wal.asset)
  workspaceLinks: WorkspaceAssetLink[];
}
