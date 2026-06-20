import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Telegram publisher — entities backing the /integrations/telegram/* API.
 *
 * Two tables:
 *   telegram_subscribers — one row per workspace (a workspace owns one
 *     TelePorter-provisioned bot).
 *   telegram_placements  — one row per /publish call. (workspace_id,
 *     external_ref) is the idempotency key — callers pass any stable
 *     string and we never double-publish for the same key.
 *
 * Migration style follows the existing TypeORM raw-SQL convention used by
 * 1764000000000-CommunicationBusinessesProfilesAssignments: IF NOT EXISTS
 * everywhere, indexes created as separate statements, FKs on
 * tenants ON DELETE SET NULL (matches WhatsApp service pattern of
 * keeping placements when a tenant goes away).
 */
export class TelegramPublisher1766000000000 implements MigrationInterface {
  name = 'TelegramPublisher1766000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---------- telegram_subscribers ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "telegram_subscribers" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "workspace_id" uuid NOT NULL,
        "tenant_id" uuid,
        "teleporter_subscriber_id" varchar(128),
        "bot_username" varchar(128),
        "invite_hint" text,
        "status" varchar(32) NOT NULL DEFAULT 'provisioning',
        "provisioned_at" TIMESTAMP WITH TIME ZONE,
        "retired_at" TIMESTAMP WITH TIME ZONE,
        "metadata" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_telegram_subscribers" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_tgs_workspace"
      ON "telegram_subscribers" ("workspace_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_tgs_tenant"
      ON "telegram_subscribers" ("tenant_id")
    `);
    // One active (non-retired) subscriber per workspace. Retired rows can coexist.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_tgs_workspace_active"
      ON "telegram_subscribers" ("workspace_id")
      WHERE "status" != 'retired'
    `);

    // ---------- telegram_placements ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "telegram_placements" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "workspace_id" uuid NOT NULL,
        "tenant_id" uuid,
        "chat_ref" varchar(255) NOT NULL,
        "text" text,
        "image_url" text,
        "parse_mode" varchar(16),
        "scheduled_at" TIMESTAMP WITH TIME ZONE,
        "external_ref" varchar(255) NOT NULL,
        "teleporter_message_id" varchar(128),
        "status" varchar(32) NOT NULL DEFAULT 'queued',
        "provider_message_id" varchar(128),
        "error_code" varchar(64),
        "error_message" text,
        "metadata" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "sent_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_telegram_placements" PRIMARY KEY ("id")
      )
    `);
    // Idempotency: same (workspace, external_ref) → same row.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_tgp_workspace_external_ref"
      ON "telegram_placements" ("workspace_id", "external_ref")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_tgp_workspace_status"
      ON "telegram_placements" ("workspace_id", "status")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_tgp_teleporter_message"
      ON "telegram_placements" ("teleporter_message_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "telegram_placements"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "telegram_subscribers"`);
  }
}
