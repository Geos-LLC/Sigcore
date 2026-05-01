import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum RouteStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

/**
 * Deterministic endpoint route — maps a provider endpoint to a tenant.
 * Primary runtime routing table. Provider webhook → endpoint/phone → tenant.
 *
 * Uniqueness: (provider, endpoint_id, channel) when active.
 * One route per provider endpoint per channel.
 */
@Entity('endpoint_routes')
export class EndpointRoute {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Which tenant this route belongs to
  @Column({ name: 'tenant_id' })
  @Index()
  tenantId: string;

  // Provider identity
  @Column()
  provider: string; // openphone, twilio, leadbridge, callio

  @Column({ name: 'provider_account_id', nullable: true })
  providerAccountId?: string;

  // Specific endpoint
  @Column({ name: 'endpoint_id', nullable: true })
  @Index()
  endpointId?: string; // phone number ID (PNm5YIDoXV), Twilio SID, webhook ID

  @Column({ name: 'phone_number', nullable: true })
  @Index()
  phoneNumber?: string; // E.164

  // Channel
  @Column({ default: 'sms' })
  channel: string; // sms, voice, email, marketplace

  // Role + purpose (hints for the receiving app)
  @Column({ nullable: true })
  role?: string;

  @Column({ nullable: true })
  purpose?: string;

  // Routing control
  @Column({ default: 0 })
  priority: number;

  @Column({
    name: 'is_active',
    default: true,
  })
  isActive: boolean;

  // Lifecycle
  @Column({ name: 'route_source', default: 'manual' })
  routeSource: string; // manual, auto_connect, auto_provision, backfill

  @Column({ name: 'activated_at', nullable: true })
  activatedAt?: Date;

  @Column({ name: 'deactivated_at', nullable: true })
  deactivatedAt?: Date;

  // App-internal routing hints (optional, validated by receiving app)
  @Column({ type: 'jsonb', nullable: true })
  metadata?: Record<string, unknown>;

  // Optional explicit override — when set, overrides the resolver's
  // best-guess profile/business for this endpoint. Null today; populated
  // by future operator UI work.
  @Column({ name: 'communication_business_id', type: 'uuid', nullable: true })
  @Index()
  communicationBusinessId?: string;

  @Column({ name: 'communication_profile_id', type: 'uuid', nullable: true })
  @Index()
  communicationProfileId?: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
