import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `transcript` (TEXT NULL) to `call_connect_sessions` so we can cache
 * the Whisper-generated transcription of the Twilio bridge recording.
 *
 * Populated lazily by CallConnectService.getOrGenerateTranscript when a
 * consumer (LB) requests GET /api/internal/call-connect/sessions/:id/transcript.
 * Never generated eagerly — avoids Whisper cost on sessions LB never
 * displays. Once written it is the cache; subsequent reads skip Whisper.
 */
export class AddTranscriptToCallConnectSessions1777000000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "call_connect_sessions" ADD COLUMN IF NOT EXISTS "transcript" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "call_connect_sessions" DROP COLUMN IF EXISTS "transcript"`,
    );
  }
}
