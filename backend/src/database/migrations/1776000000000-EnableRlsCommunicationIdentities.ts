import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Enables RLS on `communication_identities` — the one table that shipped
 * after `EnableRlsPublicTables1770000000000` (migration 1772000000000
 * added the table) and re-triggered Supabase's `rls_disabled_in_public`
 * advisor.
 *
 * Same rationale as 1770000000000: Sigcore only reads/writes through
 * TypeORM over DATABASE_URL (owner role, bypasses RLS), so enabling RLS
 * with zero policies blocks PostgREST anon/authenticated access without
 * affecting the backend. FORCE ROW LEVEL SECURITY is intentionally
 * omitted.
 *
 * Uses the DO $$ ... IF EXISTS guard so re-runs and fresh-DB boots (where
 * TypeORM synchronize may not have materialised the table yet) don't
 * error — mirrors the Callio 1770400000000 idempotent shape.
 */
export class EnableRlsCommunicationIdentities1776000000000 implements MigrationInterface {
  name = 'EnableRlsCommunicationIdentities1776000000000';

  private static readonly TABLE = 'communication_identities';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = '${EnableRlsCommunicationIdentities1776000000000.TABLE}' AND c.relkind = 'r'
  ) THEN
    EXECUTE 'ALTER TABLE "public"."${EnableRlsCommunicationIdentities1776000000000.TABLE}" ENABLE ROW LEVEL SECURITY';
  END IF;
END $$;`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = '${EnableRlsCommunicationIdentities1776000000000.TABLE}' AND c.relkind = 'r'
  ) THEN
    EXECUTE 'ALTER TABLE "public"."${EnableRlsCommunicationIdentities1776000000000.TABLE}" DISABLE ROW LEVEL SECURITY';
  END IF;
END $$;`,
    );
  }
}
