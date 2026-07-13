import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Wave-2 Task 6B.2 — Communication Identity provisioning table.
 *
 * Introduces the `communication_identities` table used by
 * POST /v1/provisioning/communication-identities. Each row maps a
 * consuming product's own workspace identifier to a Sigcore-owned
 * (workspace, tenant) pair, and exists purely to give the API a stable
 * opaque handle plus to enforce idempotency at the DB layer.
 *
 * Additive:
 *   - no existing table is touched
 *   - no data migration or backfill
 *   - foreign keys to `workspaces(id)` and `tenants(id)` with ON DELETE
 *     CASCADE so that when a workspace/tenant is torn down, the identity
 *     mapping goes with it. (Deletes are administrative-only today.)
 *   - unique index on (product, external_workspace_id) enforces the
 *     idempotency contract without relying on application-layer locks.
 *
 * Rollback (`down`) drops the table. Safe because no other Sigcore code
 * depends on it until Task 6B.2 lands the service.
 */
export class AddCommunicationIdentities1772000000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "communication_identities" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "product" varchar(64) NOT NULL,
        "external_workspace_id" varchar NOT NULL,
        "workspace_id" uuid NOT NULL,
        "tenant_id" uuid NOT NULL,
        "metadata" jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "fk_comm_identity_workspace"
          FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_comm_identity_tenant"
          FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_communication_identities_product_external"
        ON "communication_identities" ("product", "external_workspace_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_communication_identities_workspace"
        ON "communication_identities" ("workspace_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_communication_identities_tenant"
        ON "communication_identities" ("tenant_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "ix_communication_identities_tenant"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "ix_communication_identities_workspace"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_communication_identities_product_external"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "communication_identities"`);
  }
}
