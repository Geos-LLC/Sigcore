import { MigrationInterface, QueryRunner } from 'typeorm';

export class EndpointRoutes1751000000000 implements MigrationInterface {
  name = 'EndpointRoutes1751000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "endpoint_routes" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tenant_id" varchar NOT NULL,
        "provider" varchar NOT NULL,
        "provider_account_id" varchar,
        "endpoint_id" varchar,
        "phone_number" varchar,
        "channel" varchar NOT NULL DEFAULT 'sms',
        "role" varchar,
        "purpose" varchar,
        "priority" integer NOT NULL DEFAULT 0,
        "is_active" boolean NOT NULL DEFAULT true,
        "route_source" varchar NOT NULL DEFAULT 'manual',
        "activated_at" TIMESTAMP WITH TIME ZONE,
        "deactivated_at" TIMESTAMP WITH TIME ZONE,
        "metadata" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_endpoint_routes" PRIMARY KEY ("id")
      )
    `);

    // Primary lookup: exact endpoint match (Step A)
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_er_provider_endpoint_channel"
      ON "endpoint_routes" ("provider", "endpoint_id", "channel")
      WHERE "endpoint_id" IS NOT NULL AND "is_active" = true
    `);

    // Tenant listing
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_er_tenant" ON "endpoint_routes" ("tenant_id", "is_active")
    `);

    // Provider account match (Step C)
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_er_provider_account"
      ON "endpoint_routes" ("provider", "provider_account_id")
      WHERE "provider_account_id" IS NOT NULL AND "is_active" = true
    `);

    // Phone fallback (Step D)
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_er_phone"
      ON "endpoint_routes" ("phone_number")
      WHERE "phone_number" IS NOT NULL AND "is_active" = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "endpoint_routes"`);
  }
}
