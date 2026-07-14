import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Incident 2026-07-14 Phase 2 — deterministic provider-context ownership.
 *
 * Adds two columns to `communication_integrations` so that a row can carry
 * its own ownership scope instead of implicitly leaning on
 * `UNIQUE(workspace_id, provider)` + `metadata.ensure.tenantId`:
 *
 *   owner_tenant_id  uuid NULL
 *     FK -> tenants(id) ON DELETE RESTRICT. Set on rows that belong to a
 *     specific tenant (multi-tenant workspaces provisioning per-tenant
 *     subaccounts). NULL for `scope_type='WORKSPACE'` and `SYSTEM` rows.
 *     RESTRICT so a tenant cannot be deleted while integrations still
 *     reference it — the caller must migrate ownership first.
 *
 *   scope_type       varchar(20) NOT NULL DEFAULT 'WORKSPACE'
 *     Application-enforced enum: 'WORKSPACE' | 'TENANT' | 'SYSTEM'. Existing
 *     rows are backfilled to 'WORKSPACE' by the DEFAULT. New tenant-scoped
 *     rows set 'TENANT' + owner_tenant_id. SYSTEM is reserved for
 *     platform-owned integrations (e.g. shared master accounts). CHECK
 *     constraint enforces the enum at DB level.
 *
 * Indexes:
 *   - `IX_communication_integrations_owner_tenant_id` — lookups by owner
 *   - `IX_communication_integrations_scope_type` — composite index on
 *     (scope_type, workspace_id, provider) supports the ProviderContextResolver
 *     rule 3 `by_tenant` lookup and rule 4 `by_legacy_workspace_fallback`.
 *
 * IMPORTANT: the existing `UNIQUE(workspace_id, provider)` index is NOT
 * dropped in this migration. Doing so requires a separate ownership-model
 * cutover (Phase 6). Today's per-workspace-single-integration invariant is
 * preserved; Phase 6 will replace it with a partial unique that permits
 * multiple tenant-scoped rows for the same (workspace, provider).
 *
 * Additive-only, reversible. The `down()` drops the columns, constraint,
 * and indexes in reverse order.
 */
export class AddOwnerScopeToCommunicationIntegrations1774000000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. owner_tenant_id column (nullable)
    await queryRunner.query(`
      ALTER TABLE "communication_integrations"
        ADD COLUMN IF NOT EXISTS "owner_tenant_id" uuid NULL
    `);

    // 2. FK owner_tenant_id -> tenants(id) ON DELETE RESTRICT
    //    Wrapped in DO block so re-running is idempotent (pg_constraint check).
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'fk_communication_integrations_owner_tenant_id'
        ) THEN
          ALTER TABLE "communication_integrations"
            ADD CONSTRAINT "fk_communication_integrations_owner_tenant_id"
            FOREIGN KEY ("owner_tenant_id")
            REFERENCES "tenants"("id")
            ON DELETE RESTRICT;
        END IF;
      END $$;
    `);

    // 3. scope_type column with DEFAULT 'WORKSPACE' backfills existing rows.
    await queryRunner.query(`
      ALTER TABLE "communication_integrations"
        ADD COLUMN IF NOT EXISTS "scope_type" varchar(20) NOT NULL DEFAULT 'WORKSPACE'
    `);

    // 4. CHECK constraint on scope_type — application-level enum at DB layer.
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'ck_communication_integrations_scope_type'
        ) THEN
          ALTER TABLE "communication_integrations"
            ADD CONSTRAINT "ck_communication_integrations_scope_type"
            CHECK ("scope_type" IN ('WORKSPACE', 'TENANT', 'SYSTEM'));
        END IF;
      END $$;
    `);

    // 5. Indexes
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IX_communication_integrations_owner_tenant_id"
        ON "communication_integrations" ("owner_tenant_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IX_communication_integrations_scope_type"
        ON "communication_integrations" ("scope_type", "workspace_id", "provider")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IX_communication_integrations_scope_type"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IX_communication_integrations_owner_tenant_id"`,
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'ck_communication_integrations_scope_type'
        ) THEN
          ALTER TABLE "communication_integrations"
            DROP CONSTRAINT "ck_communication_integrations_scope_type";
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'fk_communication_integrations_owner_tenant_id'
        ) THEN
          ALTER TABLE "communication_integrations"
            DROP CONSTRAINT "fk_communication_integrations_owner_tenant_id";
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      ALTER TABLE "communication_integrations"
        DROP COLUMN IF EXISTS "scope_type"
    `);
    await queryRunner.query(`
      ALTER TABLE "communication_integrations"
        DROP COLUMN IF EXISTS "owner_tenant_id"
    `);
  }
}
