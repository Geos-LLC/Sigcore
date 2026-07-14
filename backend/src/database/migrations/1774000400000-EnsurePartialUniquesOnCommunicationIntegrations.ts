import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Incident 2026-07-14 Phase 4a.3 — repair index state after TypeORM SYNC_DATABASE=true
 * race resurrected the plain unique on (workspace_id, provider).
 *
 * Migration 1774000300000 (Phase 4a) attempted to swap the constraint but during
 * its deploy Sigcore prod had SYNC_DATABASE=true, so TypeORM's automatic schema
 * sync recreated the unique index under an auto-hashed name
 * (IDX_adeaae1a191d5ebd34e4cbe1bc) because the entity still declared
 * `@Index(['workspaceId', 'provider'], { unique: true })`.
 *
 * SYNC_DATABASE has since been disabled on prod (Railway env var flip). The
 * entity decorator is being removed in the same PR as this migration.
 *
 * This migration is idempotent:
 *   1. Drop any unique index on communication_integrations that has exactly
 *      (workspace_id, provider) as its columns, regardless of name.
 *   2. Ensure both partial unique indexes exist (create if missing).
 *
 * Rollback recreates the plain unique index under a stable name.
 */
export class EnsurePartialUniquesOnCommunicationIntegrations1774000400000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Drop any plain unique index on (workspace_id, provider), regardless of name.
    //    Postgres stores index column info in pg_index; we look up all unique
    //    indexes whose column set is exactly {workspace_id, provider} and drop them.
    await queryRunner.query(`
      DO $$
      DECLARE
        idx_rec RECORD;
      BEGIN
        FOR idx_rec IN
          SELECT c.relname AS indexname
          FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
          JOIN pg_class t ON t.oid = i.indrelid
          WHERE t.relname = 'communication_integrations'
            AND i.indisunique = true
            AND i.indpred IS NULL  -- exclude partial indexes
            AND i.indisprimary = false  -- exclude PK
            AND array_length(i.indkey, 1) = 2
            AND (
              SELECT array_agg(a.attname::text ORDER BY a.attnum)
              FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
              JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
            ) = ARRAY['provider', 'workspace_id']
        LOOP
          EXECUTE format('DROP INDEX IF EXISTS %I', idx_rec.indexname);
          RAISE NOTICE 'Dropped resurrected unique index: %', idx_rec.indexname;
        END LOOP;
      END$$;
    `);

    // 2. Ensure the two partial unique indexes exist.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_communication_integrations_ws_provider_workspace_scoped"
        ON "communication_integrations" ("workspace_id", "provider")
        WHERE "owner_tenant_id" IS NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_communication_integrations_ws_provider_tenant_scoped"
        ON "communication_integrations" ("workspace_id", "provider", "owner_tenant_id")
        WHERE "owner_tenant_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop the partial uniques.
    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_communication_integrations_ws_provider_workspace_scoped"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_communication_integrations_ws_provider_tenant_scoped"
    `);
    // Restore a plain unique index under a stable name.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_comm_integrations_workspace_provider"
        ON "communication_integrations" ("workspace_id", "provider")
    `);
  }
}
