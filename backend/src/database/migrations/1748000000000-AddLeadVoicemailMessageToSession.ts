import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLeadVoicemailMessageToSession1748000000000
  implements MigrationInterface
{
  name = 'AddLeadVoicemailMessageToSession1748000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "call_connect_sessions" ADD COLUMN IF NOT EXISTS "lead_voicemail_message" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "call_connect_sessions" DROP COLUMN IF EXISTS "lead_voicemail_message"`,
    );
  }
}
