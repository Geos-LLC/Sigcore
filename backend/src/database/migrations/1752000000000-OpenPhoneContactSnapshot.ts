import { MigrationInterface, QueryRunner } from 'typeorm';

export class OpenPhoneContactSnapshot1752000000000 implements MigrationInterface {
  name = 'OpenPhoneContactSnapshot1752000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "openphone_contact_snapshot" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "workspace_id" uuid NOT NULL,
        "tenant_id" uuid NOT NULL,
        "provider_account_id" varchar,
        "phone_e164" varchar(32) NOT NULL,
        "phone_last10" varchar(10) NOT NULL,
        "provider_contact_id" varchar,
        "provider_first_name" varchar(200),
        "provider_last_name" varchar(200),
        "provider_company" varchar(300),
        "provider_updated_at" TIMESTAMP WITH TIME ZONE,
        "metadata" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_openphone_contact_snapshot" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_opcs_tenant_phone" UNIQUE ("workspace_id", "tenant_id", "phone_e164")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_opcs_tenant_last10"
      ON "openphone_contact_snapshot" ("workspace_id", "tenant_id", "phone_last10")
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_opcs_tenant_contact_id"
      ON "openphone_contact_snapshot" ("workspace_id", "tenant_id", "provider_contact_id")
      WHERE "provider_contact_id" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_opcs_provider_updated"
      ON "openphone_contact_snapshot" ("provider_updated_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "openphone_contact_snapshot"`);
  }
}
