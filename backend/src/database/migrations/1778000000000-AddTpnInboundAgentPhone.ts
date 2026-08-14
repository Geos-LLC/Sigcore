import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Wave-2 Voice — deterministic per-TPN inbound routing override.
 *
 * Adds a nullable column `inbound_agent_phone_e164` on `tenant_phone_numbers`.
 * When set, the inbound Twilio voice router forwards calls for this TPN to
 * this number, regardless of `call_connect_settings` shape or count.
 *
 * Rationale: the pre-existing CC-based lookup was `findOne WHERE
 * bot_number_e164 = X ORDER BY updated_at DESC`, which is non-deterministic
 * when multiple SavedAccounts share one bot (Spotless has 33 CC rows
 * against +19045778584 — the "latest" was a diagnostic pointing at a
 * foreign phone until deleted in the 2026-08-14 Wave-1 cleanup).
 *
 * Additive, non-destructive:
 *   - nullable, no default, no backfill
 *   - no FK, no index (single-row lookup by primary key when needed)
 *   - existing routing behavior preserved for NULL (fall through to the
 *     deterministic CC pick, then tenant.metadata.callForwardingNumber,
 *     then voicemail)
 *
 * The runtime consumer lives in twilio-webhooks.service.handleIncomingCall
 * (added in the same PR as this migration).
 */
export class AddTpnInboundAgentPhone1778000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tenant_phone_numbers" ADD COLUMN IF NOT EXISTS "inbound_agent_phone_e164" varchar`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tenant_phone_numbers" DROP COLUMN IF EXISTS "inbound_agent_phone_e164"`,
    );
  }
}
