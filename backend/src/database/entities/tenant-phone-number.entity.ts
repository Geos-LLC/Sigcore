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
import { ChannelType } from './sender.entity';

export enum PhoneNumberAllocationStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  PENDING = 'pending',
}

export enum PhoneNumberProvider {
  TWILIO = 'twilio',
  OPENPHONE = 'openphone',
  WHATSAPP = 'whatsapp',
}

@Entity('tenant_phone_numbers')
@Index(['workspaceId', 'phoneNumber'], { unique: true })
@Index(['tenantId'])
export class TenantPhoneNumber {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'workspace_id' })
  @Index()
  workspaceId: string;

  @Column({ name: 'tenant_id' })
  tenantId: string;

  @ManyToOne(() => Tenant, (tenant) => tenant.phoneNumbers, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant: Tenant;

  @Column({ name: 'phone_number' })
  phoneNumber: string;

  @Column({ name: 'friendly_name', nullable: true })
  friendlyName?: string;

  @Column({
    type: 'enum',
    enum: PhoneNumberProvider,
  })
  provider: PhoneNumberProvider;

  @Column({ name: 'provider_id', nullable: true })
  providerId?: string;

  @Column({
    type: 'enum',
    enum: ChannelType,
    default: ChannelType.SMS,
  })
  channel: ChannelType;

  @Column({
    type: 'enum',
    enum: PhoneNumberAllocationStatus,
    default: PhoneNumberAllocationStatus.ACTIVE,
  })
  status: PhoneNumberAllocationStatus;

  @Column({ name: 'is_default', default: false })
  isDefault: boolean;

  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  // ==================== PROVISIONING FIELDS ====================

  @Column({ name: 'provisioned_via_callio', default: false })
  provisionedViaCallio: boolean;

  @Column({ name: 'order_id', nullable: true })
  orderId?: string;

  @Column({ name: 'monthly_cost', type: 'decimal', precision: 10, scale: 2, nullable: true })
  monthlyCost?: number;

  @Column({ name: 'provisioned_at', nullable: true })
  provisionedAt?: Date;

  // ==================== A2P 10DLC FIELDS ====================

  @Column({ name: 'messaging_service_sid', nullable: true })
  messagingServiceSid?: string;

  @Column({ name: 'a2p_campaign_id', nullable: true })
  a2pCampaignId?: string;

  @Column({ name: 'a2p_status', nullable: true })
  a2pStatus?: string;

  @Column({ name: 'a2p_attached_at', nullable: true })
  a2pAttachedAt?: Date;

  /**
   * Incident 2026-07-14 — per-number → integration ownership repair.
   *
   * FK to `communication_integrations(id)` (ON DELETE RESTRICT). Nullable
   * so pre-Phase-2 rows are grandfathered; the ProviderContextResolver's
   * rule 1 (`by_number`) uses this column when present.
   */
  @Column({ name: 'communication_integration_id', type: 'uuid', nullable: true })
  @Index()
  communicationIntegrationId?: string | null;

  /**
   * Wave-2 2026-08-14 — deterministic per-TPN inbound routing override.
   *
   * When set, the inbound Twilio voice router forwards to this number
   * without consulting call_connect_settings. Deterministic even when
   * multiple SavedAccounts share one bot number (Spotless: 33 CC rows on
   * +19045778584, all valid, no natural pick from CC alone).
   *
   * NULL leaves existing routing behavior intact (deterministic CC pick,
   * then tenant.metadata.callForwardingNumber, then voicemail).
   */
  @Column({ name: 'inbound_agent_phone_e164', type: 'varchar', nullable: true })
  inboundAgentPhoneE164?: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
