import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PR1 part 1 — schema only.
 *
 * Three new tables:
 *   communication_businesses     — customer location identity under a tenant
 *   communication_profiles       — source-bound profile under a business
 *   profile_phone_assignments    — M:N junction profile ↔ tenant_phone_numbers
 *
 * Plus nullable columns on three existing tables so the inbound resolver
 * and webhook fan-out can record/scope by profile + business:
 *   communication_conversations  +communication_business_id +communication_profile_id +profile_confidence
 *   endpoint_routes              +communication_business_id +communication_profile_id
 *   webhook_subscriptions        +communication_business_id +communication_profile_id
 *
 * No data writes — see 1764000100000-BackfillBusinessesProfilesAssignments.
 *
 * `source` on communication_profiles is varchar(32) with NO check constraint
 * (locked decision: validate at app layer only) so adding new sources
 * doesn't require a migration.
 */
export class CommunicationBusinessesProfilesAssignments1764000000000
  implements MigrationInterface
{
  name = 'CommunicationBusinessesProfilesAssignments1764000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---------- communication_businesses ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "communication_businesses" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "workspace_id" uuid NOT NULL,
        "tenant_id" uuid NOT NULL,
        "external_business_id" text,
        "display_name" text NOT NULL,
        "slug" text NOT NULL,
        "status" varchar(32) NOT NULL DEFAULT 'active',
        "default_profile_id" uuid,
        "metadata" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_communication_businesses" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_cb_workspace"
      ON "communication_businesses" ("workspace_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_cb_tenant"
      ON "communication_businesses" ("tenant_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_cb_tenant_slug"
      ON "communication_businesses" ("tenant_id", "slug")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_cb_tenant_external"
      ON "communication_businesses" ("tenant_id", "external_business_id")
      WHERE "external_business_id" IS NOT NULL
    `);

    // ---------- communication_profiles ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "communication_profiles" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "workspace_id" uuid NOT NULL,
        "tenant_id" uuid NOT NULL,
        "communication_business_id" uuid NOT NULL,
        "source" varchar(32) NOT NULL,
        "external_profile_id" text,
        "display_name" text NOT NULL,
        "slug" text NOT NULL,
        "status" varchar(32) NOT NULL DEFAULT 'active',
        "is_default" boolean NOT NULL DEFAULT false,
        "metadata" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_communication_profiles" PRIMARY KEY ("id"),
        CONSTRAINT "FK_cp_business"
          FOREIGN KEY ("communication_business_id")
          REFERENCES "communication_businesses"("id")
          ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_cp_workspace"
      ON "communication_profiles" ("workspace_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_cp_tenant"
      ON "communication_profiles" ("tenant_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_cp_business"
      ON "communication_profiles" ("communication_business_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_cp_business_slug"
      ON "communication_profiles" ("communication_business_id", "slug")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_cp_business_source_external"
      ON "communication_profiles" ("communication_business_id", "source", "external_profile_id")
      WHERE "external_profile_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_cp_business_default"
      ON "communication_profiles" ("communication_business_id")
      WHERE "is_default" = TRUE
    `);

    // FK communication_businesses.default_profile_id → communication_profiles.id (deferred until profiles table exists).
    await queryRunner.query(`
      ALTER TABLE "communication_businesses"
        ADD CONSTRAINT "FK_cb_default_profile"
        FOREIGN KEY ("default_profile_id")
        REFERENCES "communication_profiles"("id")
        ON DELETE SET NULL
    `);

    // ---------- profile_phone_assignments ----------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "profile_phone_assignments" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "profile_id" uuid NOT NULL,
        "tenant_phone_number_id" uuid NOT NULL,
        "role" varchar(32) NOT NULL DEFAULT 'primary',
        "is_default" boolean NOT NULL DEFAULT false,
        "priority" integer NOT NULL DEFAULT 100,
        "active" boolean NOT NULL DEFAULT true,
        "metadata" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_profile_phone_assignments" PRIMARY KEY ("id"),
        CONSTRAINT "FK_ppa_profile"
          FOREIGN KEY ("profile_id")
          REFERENCES "communication_profiles"("id")
          ON DELETE CASCADE,
        CONSTRAINT "FK_ppa_tenant_phone"
          FOREIGN KEY ("tenant_phone_number_id")
          REFERENCES "tenant_phone_numbers"("id")
          ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ppa_profile"
      ON "profile_phone_assignments" ("profile_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_ppa_profile_phone"
      ON "profile_phone_assignments" ("profile_id", "tenant_phone_number_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_ppa_default_per_profile"
      ON "profile_phone_assignments" ("profile_id")
      WHERE "is_default" = TRUE AND "active" = TRUE
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ppa_phone_active"
      ON "profile_phone_assignments" ("tenant_phone_number_id", "active")
    `);

    // ---------- additive nullable columns on existing tables ----------

    // communication_conversations
    await queryRunner.query(`
      ALTER TABLE "communication_conversations"
        ADD COLUMN IF NOT EXISTS "communication_business_id" uuid,
        ADD COLUMN IF NOT EXISTS "communication_profile_id" uuid,
        ADD COLUMN IF NOT EXISTS "profile_confidence" varchar(32)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_cc_communication_business"
      ON "communication_conversations" ("communication_business_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_cc_communication_profile"
      ON "communication_conversations" ("communication_profile_id")
    `);

    // endpoint_routes
    await queryRunner.query(`
      ALTER TABLE "endpoint_routes"
        ADD COLUMN IF NOT EXISTS "communication_business_id" uuid,
        ADD COLUMN IF NOT EXISTS "communication_profile_id" uuid
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_er_communication_business"
      ON "endpoint_routes" ("communication_business_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_er_communication_profile"
      ON "endpoint_routes" ("communication_profile_id")
    `);

    // webhook_subscriptions
    await queryRunner.query(`
      ALTER TABLE "webhook_subscriptions"
        ADD COLUMN IF NOT EXISTS "communication_business_id" uuid,
        ADD COLUMN IF NOT EXISTS "communication_profile_id" uuid
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ws_communication_business"
      ON "webhook_subscriptions" ("communication_business_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_ws_communication_profile"
      ON "webhook_subscriptions" ("communication_profile_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse in dependency order: drop FK on businesses → profiles first.
    await queryRunner.query(`
      ALTER TABLE "communication_businesses" DROP CONSTRAINT IF EXISTS "FK_cb_default_profile"
    `);

    // Existing-table columns
    await queryRunner.query(`
      ALTER TABLE "webhook_subscriptions"
        DROP COLUMN IF EXISTS "communication_profile_id",
        DROP COLUMN IF EXISTS "communication_business_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "endpoint_routes"
        DROP COLUMN IF EXISTS "communication_profile_id",
        DROP COLUMN IF EXISTS "communication_business_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "communication_conversations"
        DROP COLUMN IF EXISTS "profile_confidence",
        DROP COLUMN IF EXISTS "communication_profile_id",
        DROP COLUMN IF EXISTS "communication_business_id"
    `);

    // New tables
    await queryRunner.query(`DROP TABLE IF EXISTS "profile_phone_assignments"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "communication_profiles"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "communication_businesses"`);
  }
}
