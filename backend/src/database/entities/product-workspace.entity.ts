import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Unique,
} from 'typeorm';
import { Business } from './business.entity';
import { WorkspaceAssetLink } from './workspace-asset-link.entity';

export enum ProductType {
  SERVICEFLOW = 'serviceflow',
  LEADBRIDGE = 'leadbridge',
  CALLIO = 'callio',
  SIGCORE = 'sigcore',
}

export enum ProductWorkspaceStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

@Entity('product_workspaces')
@Unique(['productType', 'externalWorkspaceId'])
export class ProductWorkspace {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'business_id' })
  @Index()
  businessId: string;

  @ManyToOne(() => Business, (b) => b.workspaces)
  @JoinColumn({ name: 'business_id' })
  business: Business;

  @Column({
    name: 'product_type',
    type: 'enum',
    enum: ProductType,
  })
  productType: ProductType;

  @Column({ name: 'workspace_name' })
  workspaceName: string;

  // The app's own ID for this workspace/tenant (SF user_id, LB user_id, Callio workspace_id, Sigcore tenant_id)
  @Column({ name: 'external_workspace_id' })
  externalWorkspaceId: string;

  @Column({
    type: 'enum',
    enum: ProductWorkspaceStatus,
    default: ProductWorkspaceStatus.ACTIVE,
  })
  status: ProductWorkspaceStatus;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => WorkspaceAssetLink, (wal) => wal.workspace)
  assetLinks: WorkspaceAssetLink[];
}
