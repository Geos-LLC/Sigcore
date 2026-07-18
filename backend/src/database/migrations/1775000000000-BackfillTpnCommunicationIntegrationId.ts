import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Wave-3 completion 2026-07-18 — backfill
 * `tenant_phone_numbers.communication_integration_id` where it can be
 * inferred unambiguously from the current `communication_integrations`
 * state.
 *
 * Rationale: the resolver's rule 1 (`by_number`) is the canonical,
 * deterministic path. Every active TPN with a NULL
 * `communication_integration_id` forces the resolver to fall through to
 * rule 3 / 4, where ambiguity (workspace-scoped + tenant-scoped rows for
 * the same provider) manifests as a 409. Two tenants — Natallia and K&D
 * — hit this exact 409 in prod on 2026-07-18. This migration heals every
 * TPN whose owning integration can be identified without guessing.
 *
 * Backfill priority (mirrors PhoneNumberProvisioningService.
 * resolveIntegrationIdForTpnStamp):
 *
 *   1. TENANT-scoped row where `owner_tenant_id = tpn.tenant_id`.
 *   2. WORKSPACE-scoped row (owner_tenant_id IS NULL) for
 *      `(tpn.workspace_id, tpn.provider)`.
 *   3. Legacy — the sole active row for `(tpn.workspace_id, tpn.provider)`
 *      regardless of scope (matches the resolver's compatibility mode).
 *
 * Rows that stay ambiguous (0 or >1 candidates at every priority) are
 * left NULL; the `audit-provider-context` CLI surfaces them for manual
 * repair by the incident-response runbook.
 *
 * Idempotent: WHERE `communication_integration_id IS NULL` guards every
 * UPDATE, so re-running is a no-op after the first successful pass.
 * Additive: touches no schema, only data. Rollback simply un-stamps rows
 * (`SET communication_integration_id = NULL`) — but the PR-B code that
 * lands with this migration re-stamps them on the next TPN write, so
 * rollback of just this migration is not a full behavior rollback.
 */
export class BackfillTpnCommunicationIntegrationId1775000000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Rule 1 — TENANT-scoped exact match.
    //
    // Every id-column comparison here is wrapped in `::text` casts
    // because the base schema mixes types across tables:
    //   - `tenant_phone_numbers.workspace_id` / `tenant_id` are `varchar`
    //     (InitialSchema, 2026-02).
    //   - `communication_integrations.workspace_id` is `varchar`.
    //   - `communication_integrations.owner_tenant_id` is `uuid`
    //     (added by 1774000000000).
    //   - `provider` enums differ between the two tables.
    //
    // Prod avoided the mismatch because rows were inserted with UUID-
    // shaped strings on both sides — Postgres' runtime cast succeeded.
    // A fresh migration run against an empty DB rejects the join at
    // plan time. Casting to text keeps behavior identical in both
    // environments.
    await queryRunner.query(`
      UPDATE tenant_phone_numbers AS tpn
      SET communication_integration_id = ci.id, updated_at = NOW()
      FROM communication_integrations AS ci
      WHERE tpn.communication_integration_id IS NULL
        AND tpn.status = 'active'
        AND ci.status = 'active'
        AND ci.workspace_id::text = tpn.workspace_id::text
        AND ci.provider::text = tpn.provider::text
        AND ci.scope_type = 'TENANT'
        AND ci.owner_tenant_id::text = tpn.tenant_id::text
    `);

    // Rule 2 — WORKSPACE-scoped fallback.
    await queryRunner.query(`
      UPDATE tenant_phone_numbers AS tpn
      SET communication_integration_id = ci.id, updated_at = NOW()
      FROM communication_integrations AS ci
      WHERE tpn.communication_integration_id IS NULL
        AND tpn.status = 'active'
        AND ci.status = 'active'
        AND ci.workspace_id::text = tpn.workspace_id::text
        AND ci.provider::text = tpn.provider::text
        AND ci.scope_type = 'WORKSPACE'
        AND ci.owner_tenant_id IS NULL
    `);

    // Rule 3 — legacy sole-row fallback. Uses a lateral join so we only
    // stamp when there is exactly one active integration for the
    // (workspace, provider). NOT wrapped in a scope_type filter because
    // pre-Phase-2 workspaces may still have rows with NULL scope_type;
    // the fallback exists to heal those too.
    await queryRunner.query(`
      UPDATE tenant_phone_numbers AS tpn
      SET communication_integration_id = pick.id, updated_at = NOW()
      FROM (
        SELECT ci.workspace_id, ci.provider, ci.id
        FROM communication_integrations ci
        WHERE ci.status = 'active'
        GROUP BY ci.workspace_id, ci.provider, ci.id
        HAVING (
          SELECT COUNT(*) FROM communication_integrations ci2
          WHERE ci2.workspace_id = ci.workspace_id
            AND ci2.provider = ci.provider
            AND ci2.status = 'active'
        ) = 1
      ) pick
      WHERE tpn.communication_integration_id IS NULL
        AND tpn.status = 'active'
        AND pick.workspace_id::text = tpn.workspace_id::text
        AND pick.provider::text = tpn.provider::text
    `);

    // Also stamp phone_number_orders in the same pattern, so downstream
    // audit / billing queries can trace an order back to its integration.
    await queryRunner.query(`
      UPDATE phone_number_orders AS ord
      SET communication_integration_id = tpn.communication_integration_id, updated_at = NOW()
      FROM tenant_phone_numbers tpn
      WHERE ord.communication_integration_id IS NULL
        AND ord.tenant_phone_number_id::text = tpn.id::text
        AND tpn.communication_integration_id IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Data-only rollback: unstamp active TPNs and orders. Note this
    // leaves the resolver back in the fall-through state that broke
    // Natallia. Only meaningful as part of a full PR-B revert.
    await queryRunner.query(`
      UPDATE phone_number_orders
      SET communication_integration_id = NULL, updated_at = NOW()
      WHERE communication_integration_id IS NOT NULL
    `);
    await queryRunner.query(`
      UPDATE tenant_phone_numbers
      SET communication_integration_id = NULL, updated_at = NOW()
      WHERE communication_integration_id IS NOT NULL
    `);
  }
}
