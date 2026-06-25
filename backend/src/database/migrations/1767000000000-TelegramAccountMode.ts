import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Account-mode wrapper over TelePorter — extends telegram_subscribers
 * with 5 nullable columns so a single workspace row can flip between
 * bot mode (the existing pool-allocated bot path) and account mode
 * (recruiter's own Telegram user account, sessioned in TelePorter
 * via GramJS).
 *
 * Backfill: existing rows get mode='bot' via DEFAULT; the 4 link-related
 * columns stay NULL. Per-workspace uniqueness is unchanged — the partial
 * unique index `IDX_tgs_workspace_active` from 1766000000000 still
 * enforces one active subscription per workspace, just with mode that
 * can now flip in place.
 */
export class TelegramAccountMode1767000000000 implements MigrationInterface {
  name = 'TelegramAccountMode1767000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "telegram_subscribers"
        ADD COLUMN IF NOT EXISTS "mode" varchar(16) NOT NULL DEFAULT 'bot',
        ADD COLUMN IF NOT EXISTS "tg_user_id" varchar(64),
        ADD COLUMN IF NOT EXISTS "tg_username" varchar(128),
        ADD COLUMN IF NOT EXISTS "link_account_id" varchar(128),
        ADD COLUMN IF NOT EXISTS "link_status" varchar(32)
    `);
    // Read path for account-mode lookups by TelePorter composite key.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_tgs_link_account_id"
      ON "telegram_subscribers" ("link_account_id")
      WHERE "link_account_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_tgs_link_account_id"`);
    await queryRunner.query(`
      ALTER TABLE "telegram_subscribers"
        DROP COLUMN IF EXISTS "link_status",
        DROP COLUMN IF EXISTS "link_account_id",
        DROP COLUMN IF EXISTS "tg_username",
        DROP COLUMN IF EXISTS "tg_user_id",
        DROP COLUMN IF EXISTS "mode"
    `);
  }
}
