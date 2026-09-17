import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `agent_auto_bridge` (BOOLEAN NOT NULL DEFAULT false) to
 * `call_connect_settings`.
 *
 * When true, AGENT_FIRST calls skip the DTMF-acceptance Gather: the whisper
 * plays as an informational announcement, `initiateLeadCall` fires
 * immediately (in parallel with whisper playback), and the agent leg drops
 * straight into the conference. Removes the 15-second whisper-timeout
 * failure mode where agents who don't press a digit lose the lead.
 *
 * Default false — preserves current behavior for every existing tenant.
 * Opt-in per business/tenant by flipping the column.
 *
 * Independent from `skip_agent_whisper` on the session: the latter drops
 * the whisper audio too and is used for AI-routed calls. Auto-bridge keeps
 * the informational whisper for human agents while removing the DTMF gate.
 */
export class AddAgentAutoBridgeToCallConnectSettings1779000000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "call_connect_settings" ADD COLUMN IF NOT EXISTS "agent_auto_bridge" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "call_connect_settings" DROP COLUMN IF EXISTS "agent_auto_bridge"`,
    );
  }
}
