import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum IntegrationStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  ERROR = 'error',
}

export enum ProviderType {
  OPENPHONE = 'openphone',
  TWILIO = 'twilio',
  WHATSAPP = 'whatsapp',
  TELEGRAM = 'telegram',
}

/**
 * Wave-2 Task 6B.5A — operational readiness of a provider integration.
 *
 * Distinct from `IntegrationStatus`: `status = active` reflects the row's
 * lifecycle in Sigcore's bookkeeping; `operationalStatus` reflects whether
 * the underlying provider (e.g. Twilio) can actually service operations
 * for this integration. An `active` row with empty credentials is
 * `pending_credentials`, not `ready`.
 *
 * NULL (grandfathered): rows that predate this column — the production
 * pilot workspace and any row created before this migration — are treated
 * as `ready` by application code. Everything created via the Task 6B.2
 * provisioning API on or after this migration explicitly sets one of the
 * four enum values below.
 */
export enum OperationalStatus {
  /** Empty encrypted credentials; provider provisioning has not started. */
  PENDING_CREDENTIALS = 'pending_credentials',
  /** Subaccount / credentials / preflight is in-flight. Transient. */
  PROVISIONING = 'provisioning',
  /** Provider preflight passed; safe to route operations. */
  READY = 'ready',
  /** Provisioning or preflight failed; retry allowed. */
  ERROR = 'error',
}

/**
 * Machine-readable reason codes accompanying `operational_status`.
 * Consumers should treat unknown codes as opaque and log them verbatim.
 */
export const OperationalReasonCode = {
  TWILIO_CREDENTIALS_NOT_CONFIGURED: 'TWILIO_CREDENTIALS_NOT_CONFIGURED',
  TWILIO_SUBACCOUNT_CREATE_FAILED: 'TWILIO_SUBACCOUNT_CREATE_FAILED',
  TWILIO_AUTH_FAILED: 'TWILIO_AUTH_FAILED',
  TWILIO_PROVIDER_UNREACHABLE: 'TWILIO_PROVIDER_UNREACHABLE',
  TWILIO_SUBACCOUNT_INACTIVE: 'TWILIO_SUBACCOUNT_INACTIVE',
  TWILIO_PREFLIGHT_LIST_FAILED: 'TWILIO_PREFLIGHT_LIST_FAILED',
} as const;
export type OperationalReasonCode =
  (typeof OperationalReasonCode)[keyof typeof OperationalReasonCode];

@Entity('communication_integrations')
@Index(['workspaceId', 'provider'], { unique: true })
export class CommunicationIntegration {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'workspace_id' })
  @Index()
  workspaceId: string;

  @Column({
    type: 'enum',
    enum: ProviderType,
    default: ProviderType.OPENPHONE,
  })
  provider: ProviderType;

  @Column({ name: 'credentials_encrypted', type: 'text' })
  credentialsEncrypted: string;

  @Column({ name: 'webhook_secret_encrypted', type: 'text', nullable: true })
  webhookSecretEncrypted?: string;

  @Column({ name: 'external_workspace_id', nullable: true })
  externalWorkspaceId?: string;

  @Column({
    type: 'enum',
    enum: IntegrationStatus,
    default: IntegrationStatus.ACTIVE,
  })
  status: IntegrationStatus;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown>;

  // Wave-2 Task 6B.5A — operational readiness (see OperationalStatus).
  // Nullable so pre-6B.5A rows remain untouched; application code treats
  // NULL as `ready` (grandfathered legacy).
  @Column({
    name: 'operational_status',
    type: 'varchar',
    length: 32,
    nullable: true,
  })
  operationalStatus?: OperationalStatus | null;

  @Column({
    name: 'operational_reason',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  operationalReason?: string | null;

  // Twilio subaccount SID (`ACxxx…`) when the workspace has its own
  // subaccount. Duplicated from inside the encrypted credentials blob for
  // plaintext observability + admin queries + cleanup filters. Never the
  // master account's SID.
  @Column({
    name: 'provider_subaccount_sid',
    type: 'varchar',
    length: 64,
    nullable: true,
  })
  providerSubaccountSid?: string | null;

  @Column({
    name: 'operational_last_verified_at',
    type: 'timestamp',
    nullable: true,
  })
  operationalLastVerifiedAt?: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
