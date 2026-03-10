import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Makes CallConnect settings tenant-scoped.
 *
 * Before: call_connect_settings has business_id as PRIMARY KEY where
 *         business_id = Sigcore workspaceId (shared across all LeadBridge accounts).
 *         Multiple accounts in the same Sigcore workspace overwrite each other.
 *
 * After:  table has a UUID primary key `id`, a new `workspace_id` column
 *         (= Sigcore platform workspace from API key), and `business_id` now
 *         stores the LeadBridge per-account identifier (savedAccountId).
 *         Unique constraint: (workspace_id, business_id) — one row per account.
 *
 * Migration is backward-compatible:
 * - Existing rows get workspace_id = old business_id (they were the same value)
 * - LeadBridge re-pushes settings with businessId=savedAccountId → new per-account rows
 * - Old rows remain as legacy fallback until LeadBridge is fully updated
 */
export class TenantScopedCallConnectSettings1748200000000
  implements MigrationInterface
{
  name = 'TenantScopedCallConnectSettings1748200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Add new columns (both nullable so existing rows don't break)
    await queryRunner.query(
      `ALTER TABLE "call_connect_settings" ADD COLUMN IF NOT EXISTS "id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "call_connect_settings" ADD COLUMN IF NOT EXISTS "workspace_id" varchar`,
    );

    // 2. Populate id for existing rows
    await queryRunner.query(
      `UPDATE "call_connect_settings" SET "id" = gen_random_uuid() WHERE "id" IS NULL`,
    );

    // 3. Populate workspace_id from old business_id (they held the same value)
    await queryRunner.query(
      `UPDATE "call_connect_settings" SET "workspace_id" = "business_id" WHERE "workspace_id" IS NULL`,
    );

    // 4. Make both columns NOT NULL now that they're populated
    await queryRunner.query(
      `ALTER TABLE "call_connect_settings" ALTER COLUMN "id" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "call_connect_settings" ALTER COLUMN "workspace_id" SET NOT NULL`,
    );

    // 5. Drop old primary key on business_id
    await queryRunner.query(
      `ALTER TABLE "call_connect_settings" DROP CONSTRAINT IF EXISTS "call_connect_settings_pkey"`,
    );

    // 6. Add new primary key on id
    await queryRunner.query(
      `ALTER TABLE "call_connect_settings" ADD PRIMARY KEY ("id")`,
    );

    // 7. Add unique constraint on (workspace_id, business_id)
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_cc_settings_workspace_business"
       ON "call_connect_settings" ("workspace_id", "business_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_cc_settings_workspace_business"`,
    );
    await queryRunner.query(
      `ALTER TABLE "call_connect_settings" DROP CONSTRAINT IF EXISTS "call_connect_settings_pkey"`,
    );
    // Restore old PK on business_id
    await queryRunner.query(
      `ALTER TABLE "call_connect_settings" ADD PRIMARY KEY ("business_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "call_connect_settings" DROP COLUMN IF EXISTS "id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "call_connect_settings" DROP COLUMN IF EXISTS "workspace_id"`,
    );
  }
}
