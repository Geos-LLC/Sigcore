import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Wave-2 Voice Foundation Phase 1 (PR 2) — additive nullable column on
 * tenants for the customer-configured inbound voice endpoint URL.
 *
 * Purely additive:
 *   - no data migration
 *   - no backfill
 *   - no default value (nullable)
 *   - no changes to `webhook_url`, `webhook_secret`, or any other column
 *
 * Runtime invariant enforced by PR 2: nothing reads this column at runtime.
 * PR 3 will wire it into the inbound Twilio voice router behind the
 * SIGCORE_VOICE_INBOUND_FORWARD_ENABLED flag.
 *
 * Rollback (`down`) drops the column. Safe because no code depends on it
 * yet — no runtime read consumers, no other column FKs it, no view/index
 * references it.
 */
export class AddTenantVoiceInboundUrl1771000000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "voice_inbound_url" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tenants" DROP COLUMN IF EXISTS "voice_inbound_url"`,
    );
  }
}
