import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  OneToMany,
} from 'typeorm';
import { ProductWorkspace } from './product-workspace.entity';

export enum BusinessStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  SUSPENDED = 'suspended',
}

@Entity('businesses')
export class Business {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ name: 'legal_name', nullable: true })
  legalName?: string;

  // Informational only — NOT used for routing or identity resolution
  @Column({ name: 'main_phone', nullable: true })
  mainPhone?: string;

  // Informational only — NOT used for routing or identity resolution
  @Column({ name: 'main_email', nullable: true })
  mainEmail?: string;

  @Column({ nullable: true })
  website?: string;

  // Caller-provided idempotency key for create-or-resolve
  @Column({ name: 'external_id', nullable: true })
  @Index({ unique: true, where: '"external_id" IS NOT NULL' })
  externalId?: string;

  @Column({
    type: 'enum',
    enum: BusinessStatus,
    default: BusinessStatus.ACTIVE,
  })
  status: BusinessStatus;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @OneToMany(() => ProductWorkspace, (pw) => pw.business)
  workspaces: ProductWorkspace[];
}
