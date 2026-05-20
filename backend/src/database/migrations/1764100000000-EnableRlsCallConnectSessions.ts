import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Supabase Security Advisor flagged `public.call_connect_sessions` as RLS-disabled.
 * The table is only accessed by the Sigcore backend via TypeORM over DATABASE_URL
 * (direct Postgres connection, table-owner role) — never by an anon/authenticated
 * Supabase client and never via PostgREST. Enabling RLS with zero policies blocks
 * the `anon` and `authenticated` PostgREST roles from selecting/inserting/updating/
 * deleting any rows, while the backend connection (owner role, RLS bypass) is
 * unaffected. We deliberately do NOT add policies — there is no public access
 * path that needs them, and FORCE ROW LEVEL SECURITY is intentionally omitted so
 * the backend continues to read/write normally.
 */
export class EnableRlsCallConnectSessions1764100000000
  implements MigrationInterface
{
  name = 'EnableRlsCallConnectSessions1764100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "public"."call_connect_sessions" ENABLE ROW LEVEL SECURITY`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "public"."call_connect_sessions" DISABLE ROW LEVEL SECURITY`,
    );
  }
}
