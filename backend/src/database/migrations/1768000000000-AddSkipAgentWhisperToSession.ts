import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSkipAgentWhisperToSession1768000000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "call_connect_sessions" ADD COLUMN IF NOT EXISTS "skip_agent_whisper" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "call_connect_sessions" ALTER COLUMN "skip_agent_whisper" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "call_connect_sessions" DROP COLUMN IF EXISTS "skip_agent_whisper"`,
    );
  }
}
