import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * OpenPhone /contacts is workspace-level data (one integration per workspace),
 * but the original snapshot table was keyed on (workspace, tenant, phone).
 * This caused duplicate snapshot rows when multiple tenants share the workspace's
 * OpenPhone integration, and also meant a snapshot populated by tenant A wasn't
 * visible to tenant B's conversation lookups.
 *
 * Rework: snapshots are now unique on (workspace_id, provider_account_id, phone_e164).
 * tenant_id kept for audit but nullable.
 */
export class SnapshotWorkspaceScope1752000300000 implements MigrationInterface {
  name = 'SnapshotWorkspaceScope1752000300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Drop the old unique constraint (workspace_id, tenant_id, phone_e164)
    await queryRunner.query(`ALTER TABLE "openphone_contact_snapshot" DROP CONSTRAINT IF EXISTS "UQ_opcs_tenant_phone"`);

    // Make tenant_id nullable
    await queryRunner.query(`ALTER TABLE "openphone_contact_snapshot" ALTER COLUMN "tenant_id" DROP NOT NULL`);

    // Default provider_account_id to empty string (sentinel — matches participants behavior)
    await queryRunner.query(`UPDATE "openphone_contact_snapshot" SET "provider_account_id" = '' WHERE "provider_account_id" IS NULL`);
    await queryRunner.query(`ALTER TABLE "openphone_contact_snapshot" ALTER COLUMN "provider_account_id" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "openphone_contact_snapshot" ALTER COLUMN "provider_account_id" SET DEFAULT ''`);

    // Dedupe: keep newest row per (workspace_id, provider_account_id, phone_e164)
    await queryRunner.query(`
      DELETE FROM "openphone_contact_snapshot" t
      USING "openphone_contact_snapshot" t2
      WHERE t.workspace_id = t2.workspace_id
        AND t.provider_account_id = t2.provider_account_id
        AND t.phone_e164 = t2.phone_e164
        AND t.updated_at < t2.updated_at
    `);

    // New unique constraint
    await queryRunner.query(`
      ALTER TABLE "openphone_contact_snapshot"
      ADD CONSTRAINT "UQ_opcs_workspace_account_phone"
      UNIQUE ("workspace_id", "provider_account_id", "phone_e164")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "openphone_contact_snapshot" DROP CONSTRAINT IF EXISTS "UQ_opcs_workspace_account_phone"`);
    // We don't restore tenant_id NOT NULL or the old constraint (would need data backfill).
  }
}
