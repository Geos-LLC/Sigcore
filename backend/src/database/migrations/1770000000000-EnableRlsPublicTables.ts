import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Supabase Security Advisor flagged every remaining `public` table as
 * `rls_disabled_in_public` — Supabase auto-exposes public tables through
 * PostgREST, so with RLS off the `anon`/`authenticated` roles can read and
 * mutate anything anyone with the project's anon key wants to touch.
 *
 * Sigcore only reads/writes these tables through TypeORM over DATABASE_URL
 * (owner role, bypasses RLS). Enabling RLS with zero policies blocks
 * PostgREST while leaving the backend unaffected. Mirrors the pattern in
 * 1764100000000-EnableRlsCallConnectSessions.ts. FORCE ROW LEVEL SECURITY
 * is intentionally omitted.
 *
 * `webhook_subscriptions` was also flagged by `sensitive_columns_exposed`
 * (it holds the outbound HMAC signing secret) — enabling RLS resolves both
 * findings at once.
 */
export class EnableRlsPublicTables1770000000000 implements MigrationInterface {
  name = 'EnableRlsPublicTables1770000000000';

  private static readonly TABLES = [
    'api_keys',
    'businesses',
    'call_connect_settings',
    'communication_businesses',
    'communication_calls',
    'communication_conversations',
    'communication_integrations',
    'communication_messages',
    'communication_participants',
    'communication_profiles',
    'contact_identities',
    'endpoint_routes',
    'migrations',
    'openphone_contact_snapshot',
    'phone_number_assignments',
    'phone_number_orders',
    'phone_number_pricing',
    'product_workspaces',
    'profile_phone_assignments',
    'senders',
    'shared_communication_assets',
    'sms_messages',
    'telegram_placements',
    'telegram_subscribers',
    'tenant_integrations',
    'tenant_phone_numbers',
    'tenants',
    'webhook_events',
    'webhook_subscriptions',
    'workspace_asset_links',
    'workspaces',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of EnableRlsPublicTables1770000000000.TABLES) {
      await queryRunner.query(
        `ALTER TABLE "public"."${table}" ENABLE ROW LEVEL SECURITY`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of EnableRlsPublicTables1770000000000.TABLES) {
      await queryRunner.query(
        `ALTER TABLE "public"."${table}" DISABLE ROW LEVEL SECURITY`,
      );
    }
  }
}
