import { MigrationInterface, QueryRunner } from 'typeorm';

export class BusinessIdentityModel1750000000000
  implements MigrationInterface
{
  name = 'BusinessIdentityModel1750000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Enums ──
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "business_status" AS ENUM ('active', 'inactive', 'suspended');
      EXCEPTION WHEN duplicate_object THEN null;
      END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "product_type" AS ENUM ('serviceflow', 'leadbridge', 'callio', 'sigcore');
      EXCEPTION WHEN duplicate_object THEN null;
      END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "product_workspace_status" AS ENUM ('active', 'inactive');
      EXCEPTION WHEN duplicate_object THEN null;
      END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "asset_type" AS ENUM ('phone', 'email', 'provider_number', 'provider_account', 'inbox_identity');
      EXCEPTION WHEN duplicate_object THEN null;
      END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "asset_status" AS ENUM ('active', 'inactive');
      EXCEPTION WHEN duplicate_object THEN null;
      END $$
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "link_status" AS ENUM ('active', 'inactive');
      EXCEPTION WHEN duplicate_object THEN null;
      END $$
    `);

    // ── Table 1: businesses ──
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "businesses" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" varchar NOT NULL,
        "legal_name" varchar,
        "main_phone" varchar,
        "main_email" varchar,
        "website" varchar,
        "external_id" varchar,
        "status" "business_status" NOT NULL DEFAULT 'active',
        "metadata" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_businesses" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_businesses_external_id"
      ON "businesses" ("external_id") WHERE "external_id" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_businesses_name" ON "businesses" ("name")
    `);

    // ── Table 2: product_workspaces ──
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "product_workspaces" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "business_id" uuid NOT NULL,
        "product_type" "product_type" NOT NULL,
        "workspace_name" varchar NOT NULL,
        "external_workspace_id" varchar NOT NULL,
        "status" "product_workspace_status" NOT NULL DEFAULT 'active',
        "metadata" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_product_workspaces" PRIMARY KEY ("id"),
        CONSTRAINT "FK_product_workspaces_business" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_product_workspaces_type_external"
      ON "product_workspaces" ("product_type", "external_workspace_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_product_workspaces_business" ON "product_workspaces" ("business_id")
    `);

    // ── Table 3: shared_communication_assets ──
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "shared_communication_assets" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "asset_type" "asset_type" NOT NULL,
        "normalized_value" varchar NOT NULL,
        "display_value" varchar,
        "provider" varchar,
        "external_asset_id" varchar,
        "status" "asset_status" NOT NULL DEFAULT 'active',
        "metadata" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_shared_communication_assets" PRIMARY KEY ("id")
      )
    `);
    // Generic assets (phone, email): unique by (type, value) — provider-agnostic
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_sca_generic_unique"
      ON "shared_communication_assets" ("asset_type", "normalized_value")
      WHERE "asset_type" IN ('phone', 'email')
    `);
    // Provider-specific assets: unique by (type, value, provider)
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_sca_provider_unique"
      ON "shared_communication_assets" ("asset_type", "normalized_value", "provider")
      WHERE "asset_type" IN ('provider_number', 'provider_account', 'inbox_identity') AND "provider" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_sca_normalized_value" ON "shared_communication_assets" ("normalized_value")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_sca_external_asset_id" ON "shared_communication_assets" ("external_asset_id")
    `);

    // ── Table 4: workspace_asset_links ──
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "workspace_asset_links" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "workspace_id" uuid NOT NULL,
        "asset_id" uuid NOT NULL,
        "role" varchar NOT NULL,
        "purpose" varchar,
        "is_primary" boolean NOT NULL DEFAULT false,
        "status" "link_status" NOT NULL DEFAULT 'active',
        "metadata" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_workspace_asset_links" PRIMARY KEY ("id"),
        CONSTRAINT "FK_wal_workspace" FOREIGN KEY ("workspace_id") REFERENCES "product_workspaces"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_wal_asset" FOREIGN KEY ("asset_id") REFERENCES "shared_communication_assets"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_wal_workspace_asset_role"
      ON "workspace_asset_links" ("workspace_id", "asset_id", "role")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_wal_asset" ON "workspace_asset_links" ("asset_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_wal_workspace" ON "workspace_asset_links" ("workspace_id")
    `);

    // ── Add columns to existing tenants table ──
    await queryRunner.query(`
      ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "business_identity_id" uuid
    `);
    await queryRunner.query(`
      ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "product_workspace_id" uuid
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Remove tenant columns
    await queryRunner.query(`ALTER TABLE "tenants" DROP COLUMN IF EXISTS "product_workspace_id"`);
    await queryRunner.query(`ALTER TABLE "tenants" DROP COLUMN IF EXISTS "business_identity_id"`);

    // Drop tables in dependency order
    await queryRunner.query(`DROP TABLE IF EXISTS "workspace_asset_links"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "shared_communication_assets"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "product_workspaces"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "businesses"`);

    // Drop enums
    await queryRunner.query(`DROP TYPE IF EXISTS "link_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "asset_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "asset_type"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "product_workspace_status"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "product_type"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "business_status"`);
  }
}
