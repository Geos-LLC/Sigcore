import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Incident 2026-07-14 Phase 2 — TPN → provider integration ownership link.
 *
 * Adds `communication_integration_id` (nullable, FK RESTRICT) to
 * `tenant_phone_numbers`. This is the per-number ownership handle that the
 * ProviderContextResolver's rule 1 (`by_number`) uses to deterministically
 * map an inbound/outbound number to the exact integration row responsible
 * for it. Nullable so pre-Phase-2 rows are grandfathered — the resolver
 * falls back to `by_tenant` / `by_legacy_workspace_fallback` when the
 * column is NULL.
 *
 * FK ON DELETE RESTRICT so integrations cannot be deleted while phone
 * numbers still reference them; callers must migrate ownership first.
 *
 * NOT enforced by trigger: cross-workspace / cross-provider consistency
 * between `tenant_phone_numbers` and the referenced integration must be
 * enforced at the application layer (see
 * `ProviderContextResolver.assertConsistency` and the integration-resource
 * guard's ambiguity check). A DB trigger would be more airtight but adds
 * migration/rollback complexity and duplicates work that already exists in
 * TypeScript. The application layer is authoritative.
 *
 * Additive-only, reversible.
 */
export class AddIntegrationIdToTenantPhoneNumbers1774000100000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "tenant_phone_numbers"
        ADD COLUMN IF NOT EXISTS "communication_integration_id" uuid NULL
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'fk_tenant_phone_numbers_communication_integration_id'
        ) THEN
          ALTER TABLE "tenant_phone_numbers"
            ADD CONSTRAINT "fk_tenant_phone_numbers_communication_integration_id"
            FOREIGN KEY ("communication_integration_id")
            REFERENCES "communication_integrations"("id")
            ON DELETE RESTRICT;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IX_tenant_phone_numbers_communication_integration_id"
        ON "tenant_phone_numbers" ("communication_integration_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IX_tenant_phone_numbers_communication_integration_id"`,
    );
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'fk_tenant_phone_numbers_communication_integration_id'
        ) THEN
          ALTER TABLE "tenant_phone_numbers"
            DROP CONSTRAINT "fk_tenant_phone_numbers_communication_integration_id";
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      ALTER TABLE "tenant_phone_numbers"
        DROP COLUMN IF EXISTS "communication_integration_id"
    `);
  }
}
