import { MigrationInterface, QueryRunner } from 'typeorm';

export class ConversationParticipantFk1752000200000 implements MigrationInterface {
  name = 'ConversationParticipantFk1752000200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "communication_conversations"
      ADD COLUMN IF NOT EXISTS "participant_id" uuid
    `);
    await queryRunner.query(`
      ALTER TABLE "communication_conversations"
      ADD COLUMN IF NOT EXISTS "participant_key" text
    `);
    await queryRunner.query(`
      ALTER TABLE "communication_conversations"
      ADD COLUMN IF NOT EXISTS "participant_phone_e164" varchar(32)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_cc_participant_id"
      ON "communication_conversations" ("participant_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_cc_participant_key"
      ON "communication_conversations" ("participant_key")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_cc_participant_key"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_cc_participant_id"`);
    await queryRunner.query(`ALTER TABLE "communication_conversations" DROP COLUMN IF EXISTS "participant_phone_e164"`);
    await queryRunner.query(`ALTER TABLE "communication_conversations" DROP COLUMN IF EXISTS "participant_key"`);
    await queryRunner.query(`ALTER TABLE "communication_conversations" DROP COLUMN IF EXISTS "participant_id"`);
  }
}
