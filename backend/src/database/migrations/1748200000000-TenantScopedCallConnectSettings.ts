import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds workspace_id column to call_connect_settings for audit/query purposes.
 *
 * Business logic change (no DB PK change needed):
 * - Legacy rows: business_id = Sigcore workspaceId (shared within workspace)
 * - New rows:    business_id = LeadBridge savedAccountId (per-account isolation)
 *
 * The service now uses dto.businessId (= savedAccountId) as the PK key,
 * which gives each LeadBridge account its own settings row within the
 * shared Sigcore workspace — without any PK or schema structure change.
 *
 * workspace_id is populated as = business_id for legacy rows (they held the same value).
 */
export class TenantScopedCallConnectSettings1748200000000
  implements MigrationInterface
{
  name = 'TenantScopedCallConnectSettings1748200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "call_connect_settings" ADD COLUMN IF NOT EXISTS "workspace_id" varchar`,
    );
    // Populate workspace_id for existing rows (business_id was the workspaceId)
    await queryRunner.query(
      `UPDATE "call_connect_settings" SET "workspace_id" = "business_id" WHERE "workspace_id" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "call_connect_settings" DROP COLUMN IF EXISTS "workspace_id"`,
    );
  }
}
