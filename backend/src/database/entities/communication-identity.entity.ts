import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

/**
 * Wave-2 Task 6B.2 — Communication Identity.
 *
 * A Communication Identity is the abstract handle that a consuming product
 * (Callio today, others later) receives when it requests communication
 * infrastructure from Sigcore. Internally it maps 1:1 to a
 * (workspace, tenant, integration set) triple in Sigcore's tables, but
 * consumers must treat this row's `id` as opaque and NOT depend on the
 * mapping.
 *
 * Ownership: Sigcore. Consuming products call the provisioning endpoint
 * (POST /v1/provisioning/communication-identities) to obtain a row here
 * plus its dependent Sigcore-owned rows. They never insert directly.
 *
 * Idempotency: unique on (product, external_workspace_id). The consumer's
 * own workspace identifier is what they present each call; Sigcore looks
 * that up and returns the existing identity if one already exists for that
 * product.
 */
@Entity('communication_identities')
@Index(['product', 'externalWorkspaceId'], { unique: true })
export class CommunicationIdentity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /**
   * Which consuming product asked for this identity. Free-form string so
   * we don't need a schema change to onboard the next product. Enforced
   * client-side by the DTO's `@IsIn(...)` guard.
   */
  @Column({ length: 64 })
  product: string;

  /**
   * The consumer's own workspace/organization identifier. What Callio
   * calls a `workspace.id`, what LeadBridge would call an `org id`, etc.
   * Sigcore keeps this as an opaque string.
   */
  @Column({ name: 'external_workspace_id' })
  externalWorkspaceId: string;

  /**
   * FK to the Sigcore workspace this identity is bound to.
   * Not exposed on the public API — consumers treat the identity as opaque.
   */
  @Column({ name: 'workspace_id', type: 'uuid' })
  @Index()
  workspaceId: string;

  /**
   * FK to the Sigcore tenant that Sigcore-owned resources hang off of
   * (phone numbers, integrations, etc). Again — internal.
   */
  @Column({ name: 'tenant_id', type: 'uuid' })
  @Index()
  tenantId: string;

  /**
   * Consumer-supplied opaque metadata. Sigcore does not interpret this.
   */
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
