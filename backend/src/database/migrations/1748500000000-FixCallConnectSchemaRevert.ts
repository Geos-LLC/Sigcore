import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Corrective migration: revert schema changes made by the original
 * 1748200000000-TenantScopedCallConnectSettings migration if they ran.
 *
 * The original migration changed the PK from business_id → id (uuid), which
 * conflicted with the entity definition that keeps business_id as PK.
 * TypeORM synchronize could not reconcile the mismatch, causing a crash loop.
 *
 * This migration:
 * 1. Detects if the `id` column exists (i.e., original migration ran)
 * 2. If so, restores business_id as PRIMARY KEY and drops the id column
 * 3. Makes workspace_id nullable to match the entity
 *
 * Safe to run multiple times (all steps use IF EXISTS / conditional).
 */
export class FixCallConnectSchemaRevert1748500000000
  implements MigrationInterface
{
  name = 'FixCallConnectSchemaRevert1748500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Check if `id` column exists (means original PK-change migration ran)
    const [idColExists] = await queryRunner.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'call_connect_settings' AND column_name = 'id'
    `);

    if (idColExists) {
      // Drop unique index created by original migration
      await queryRunner.query(
        `DROP INDEX IF EXISTS "IDX_cc_settings_workspace_business"`,
      );

      // Drop the current PK (which is on `id`)
      await queryRunner.query(
        `ALTER TABLE "call_connect_settings" DROP CONSTRAINT IF EXISTS "call_connect_settings_pkey"`,
      );

      // Restore original PK on business_id
      await queryRunner.query(
        `ALTER TABLE "call_connect_settings" ADD PRIMARY KEY ("business_id")`,
      );

      // Remove id column
      await queryRunner.query(
        `ALTER TABLE "call_connect_settings" DROP COLUMN IF EXISTS "id"`,
      );
    }

    // Ensure workspace_id is nullable (original migration set it NOT NULL)
    await queryRunner.query(`
      ALTER TABLE "call_connect_settings"
        ALTER COLUMN "workspace_id" DROP NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // No safe rollback for this corrective migration
  }
}
