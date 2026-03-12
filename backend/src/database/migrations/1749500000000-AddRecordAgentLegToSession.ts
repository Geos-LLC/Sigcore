import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRecordAgentLegToSession1749500000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "call_connect_sessions" ADD COLUMN IF NOT EXISTS "record_agent_leg" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "call_connect_sessions" ALTER COLUMN "record_agent_leg" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "call_connect_sessions" DROP COLUMN IF EXISTS "record_agent_leg"`,
    );
  }
}
