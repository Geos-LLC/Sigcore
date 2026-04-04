import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import { ProductWorkspace } from './product-workspace.entity';
import { SharedCommunicationAsset } from './shared-communication-asset.entity';

export enum LinkStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

/**
 * Links a shared communication asset to a product workspace with a specific role and purpose.
 *
 * Uniqueness: (workspace_id, asset_id, role) — the same asset can be linked to the same workspace
 * with different roles (e.g., both 'business_contact' and 'notification_sender').
 * Purpose is NOT part of uniqueness — it's metadata describing how the role is used.
 */
@Entity('workspace_asset_links')
@Unique(['workspaceId', 'assetId', 'role'])
export class WorkspaceAssetLink {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'workspace_id' })
  @Index()
  workspaceId: string;

  @ManyToOne(() => ProductWorkspace, (pw) => pw.assetLinks)
  @JoinColumn({ name: 'workspace_id' })
  workspace: ProductWorkspace;

  @Column({ name: 'asset_id' })
  @Index()
  assetId: string;

  @ManyToOne(() => SharedCommunicationAsset, (a) => a.workspaceLinks)
  @JoinColumn({ name: 'asset_id' })
  asset: SharedCommunicationAsset;

  // What role this asset plays for this workspace
  // Examples: 'business_contact', 'leadbridge_assigned_number', 'callio_main_inbox',
  //           'sigcore_registered_number', 'provider_account', 'notification_sender'
  @Column()
  role: string;

  // Optional: how this role is used
  // Examples: 'lead_capture', 'main_business_line', 'general_inbox', 'alerts', 'dispatch'
  @Column({ nullable: true })
  purpose?: string;

  @Column({ name: 'is_primary', default: false })
  isPrimary: boolean;

  @Column({
    type: 'enum',
    enum: LinkStatus,
    default: LinkStatus.ACTIVE,
  })
  status: LinkStatus;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
