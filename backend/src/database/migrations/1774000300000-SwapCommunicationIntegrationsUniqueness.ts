import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Incident 2026-07-14 Phase 4a — swap the `communication_integrations`
 * uniqueness model to permit both workspace-scoped and tenant-scoped rows
 * for the same (workspace_id, provider) pair.
 *
 * Before this migration, `communication_integrations` had a single unique
 * index `IDX_comm_integrations_workspace_provider` on (workspace_id, provider)
 * — created by the InitialSchema migration (1700000000000). That invariant
 * forced every workspace to hold at most one integration row per provider,
 * which was fine while the LeadBridge workspace had a single workspace-scoped
 * Twilio integration but breaks Phase 4 which needs the Callio tenant-scoped
 * integration row to coexist with the LB workspace-scoped one in the same
 * (workspace, provider) space.
 *
 * The Phase 2 migration (1774000000000) added the `owner_tenant_id` and
 * `scope_type` columns but explicitly deferred the unique-index swap — this
 * migration does it.
 *
 * After this migration:
 *   * At most one workspace-scoped row per (workspace_id, provider):
 *       WHERE owner_tenant_id IS NULL
 *   * At most one tenant-scoped row per (workspace_id, provider, owner_tenant_id):
 *       WHERE owner_tenant_id IS NOT NULL
 *
 * Enables the Callio tenant-scoped integration row to coexist with the LB
 * workspace-scoped integration row. Legacy code that does
 * `findOne({workspaceId, provider})` still returns exactly one row when the
 * workspace has only one scope populated (backward-compat for compat-mode
 * resolver rule 4).
 *
 * Naming convention: the pre-existing object is a UNIQUE INDEX (not a
 * table CONSTRAINT) named `IDX_comm_integrations_workspace_provider` —
 * verified against InitialSchema1700000000000. We drop the index (defensively
 * probe pg_indexes / pg_constraint so a rename or a manual-repro conversion
 * doesn't break the migration) and create the two partial indexes with the
 * names spec'd for Phase 4a.
 *
 * Strict superset: any pair of rows that validated under the old constraint
 * also validates under the new partial pair — old constraint permitted at
 * most one row per (workspace_id, provider); new pair permits at most one
 * workspace-scoped + N tenant-scoped rows per (workspace_id, provider) with
 * distinct owner_tenant_id. Pre-existing rows all have owner_tenant_id=NULL
 * (backfilled by 1774000000000 default), so they collapse to the first
 * partial index and remain unique.
 *
 * Reversible: down() drops the two partial indexes and restores the
 * original unique index under the same name.
 */
export class SwapCommunicationIntegrationsUniqueness1774000300000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Drop the pre-existing uniqueness object. It ships from InitialSchema
    //    as an INDEX (`IDX_comm_integrations_workspace_provider`), but if a
    //    prior manual repair converted it into a table-level CONSTRAINT with
    //    a different name (e.g. `UQ_workspace_id_provider`), drop that too.
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_comm_integrations_workspace_provider"`,
    );
    await queryRunner.query(`
      DO $$
      DECLARE
        cons_name text;
      BEGIN
        SELECT conname INTO cons_name
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'communication_integrations'
          AND c.contype = 'u'
          AND (
            conname = 'UQ_workspace_id_provider'
            OR conname = 'UQ_comm_integrations_workspace_provider'
          );
        IF cons_name IS NOT NULL THEN
          EXECUTE format(
            'ALTER TABLE "communication_integrations" DROP CONSTRAINT %I',
            cons_name
          );
        END IF;
      END $$;
    `);

    // 2. Partial UNIQUE for workspace-scoped rows.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        "UQ_communication_integrations_ws_provider_workspace_scoped"
      ON "communication_integrations" ("workspace_id", "provider")
      WHERE "owner_tenant_id" IS NULL
    `);

    // 3. Partial UNIQUE for tenant-scoped rows.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        "UQ_communication_integrations_ws_provider_tenant_scoped"
      ON "communication_integrations" ("workspace_id", "provider", "owner_tenant_id")
      WHERE "owner_tenant_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse of up().
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_communication_integrations_ws_provider_tenant_scoped"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_communication_integrations_ws_provider_workspace_scoped"`,
    );
    // Restore the original unique index under its InitialSchema name.
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_comm_integrations_workspace_provider" ON "communication_integrations" ("workspace_id", "provider")`,
    );
  }
}
