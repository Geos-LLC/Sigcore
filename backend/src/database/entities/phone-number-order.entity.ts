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
import { Tenant } from './tenant.entity';
import { TenantPhoneNumber } from './tenant-phone-number.entity';

export enum PhoneNumberOrderType {
  PURCHASE = 'purchase',
  RELEASE = 'release',
}

export enum PhoneNumberOrderStatus {
  PENDING = 'pending',
  PROVISIONING = 'provisioning',
  ACTIVE = 'active',
  RELEASING = 'releasing',
  RELEASED = 'released',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

@Entity('phone_number_orders')
@Index(['workspaceId', 'createdAt'])
@Index(['tenantId'])
export class PhoneNumberOrder {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'workspace_id' })
  @Index()
  workspaceId: string;

  @Column({ name: 'tenant_id', nullable: true })
  tenantId?: string;

  @ManyToOne(() => Tenant, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'tenant_id' })
  tenant?: Tenant;

  @Column({ name: 'phone_number', nullable: true })
  phoneNumber?: string;

  @Column({ name: 'phone_number_sid', nullable: true })
  phoneNumberSid?: string;

  @Column({
    name: 'order_type',
    type: 'enum',
    enum: PhoneNumberOrderType,
  })
  orderType: PhoneNumberOrderType;

  @Column({
    type: 'enum',
    enum: PhoneNumberOrderStatus,
    default: PhoneNumberOrderStatus.PENDING,
  })
  status: PhoneNumberOrderStatus;

  @Column({ name: 'twilio_cost', type: 'decimal', precision: 10, scale: 4, default: 0 })
  twilioCost: number;

  @Column({ name: 'markup_amount', type: 'decimal', precision: 10, scale: 4, default: 0 })
  markupAmount: number;

  @Column({ name: 'total_price', type: 'decimal', precision: 10, scale: 4, default: 0 })
  totalPrice: number;

  @Column({ name: 'search_country', nullable: true })
  searchCountry?: string;

  @Column({ name: 'search_area_code', nullable: true })
  searchAreaCode?: string;

  @Column({ name: 'ordered_by', nullable: true })
  orderedBy?: string;

  @Column({ name: 'tenant_phone_number_id', nullable: true })
  tenantPhoneNumberId?: string;

  @ManyToOne(() => TenantPhoneNumber, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'tenant_phone_number_id' })
  tenantPhoneNumber?: TenantPhoneNumber;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  /**
   * Incident 2026-07-14 — per-number → integration ownership repair.
   *
   * The provider integration that fulfilled the number purchase / release.
   * Nullable for legacy rows.
   */
  @Column({ name: 'communication_integration_id', type: 'uuid', nullable: true })
  @Index()
  communicationIntegrationId?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  @Column({ name: 'completed_at', nullable: true })
  completedAt?: Date;
}
