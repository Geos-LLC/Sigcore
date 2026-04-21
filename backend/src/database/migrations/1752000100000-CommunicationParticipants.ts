import { MigrationInterface, QueryRunner } from 'typeorm';

export class CommunicationParticipants1752000100000 implements MigrationInterface {
  name = 'CommunicationParticipants1752000100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "communication_participants" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "workspace_id" uuid NOT NULL,
        "tenant_id" uuid NOT NULL,
        "provider" varchar NOT NULL,
        "provider_account_id" varchar NOT NULL DEFAULT '',
        "participant_key" text NOT NULL,
        "normalized_phone_e164" varchar(32) NOT NULL,
        "raw_phone" varchar,
        "provider_contact_id" varchar,
        "provider_display_name" varchar,
        "provider_company" varchar,
        "first_seen_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "last_seen_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_communication_participants" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_cp_identity" UNIQUE ("workspace_id", "tenant_id", "provider", "provider_account_id", "normalized_phone_e164")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_cp_participant_key"
      ON "communication_participants" ("participant_key")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_cp_provider_contact_id"
      ON "communication_participants" ("workspace_id", "tenant_id", "provider", "provider_contact_id")
      WHERE "provider_contact_id" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_cp_phone_lookup"
      ON "communication_participants" ("workspace_id", "tenant_id", "normalized_phone_e164")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "communication_participants"`);
  }
}
