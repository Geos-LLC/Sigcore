import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  classifyTenantSource,
  makeSlug,
  ProfileSourceValue,
} from './_helpers/source-classifier';

/**
 * PR1 part 2 — idempotent data backfill.
 *
 * For every existing tenant, create:
 *   1. one communication_businesses row (display_name = tenant.name,
 *      slug = "<slugify(name)>-<id8>", external_business_id = tenant.external_id
 *      ONLY when source classifies as 'leadbridge', else NULL)
 *   2. one default communication_profiles row (slug = 'default',
 *      source = classifyTenantSource(...), is_default = TRUE)
 *   3. set communication_businesses.default_profile_id to that profile
 *
 * For every tenant_phone_numbers row, create one profile_phone_assignments
 * row pointing at the tenant's default profile (role=primary, is_default=TRUE,
 * priority=100, active=TRUE).
 *
 * For every communication_conversations row that has a tenant_id, populate
 * communication_business_id, communication_profile_id, and
 * profile_confidence='phone_default'.
 *
 * Idempotent — re-running this migration is a no-op.
 */
export class BackfillBusinessesProfilesAssignments1764000100000
  implements MigrationInterface
{
  name = 'BackfillBusinessesProfilesAssignments1764000100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---------- 1. Load tenants + per-tenant signal bundles ----------
    const tenants: Array<{
      id: string;
      workspace_id: string;
      name: string | null;
      external_id: string | null;
    }> = await queryRunner.query(
      `SELECT id, workspace_id, name, external_id FROM tenants`,
    );

    if (tenants.length === 0) return;

    const webhooksRaw: Array<{ tenant_id: string; webhook_url: string }> =
      await queryRunner.query(
        `SELECT tenant_id, webhook_url FROM webhook_subscriptions
         WHERE tenant_id IS NOT NULL AND webhook_url IS NOT NULL`,
      );
    const apiKeysRaw: Array<{ tenant_id: string; name: string }> =
      await queryRunner.query(
        `SELECT tenant_id, name FROM api_keys
         WHERE tenant_id IS NOT NULL AND name IS NOT NULL`,
      );

    const webhookUrlsByTenant = new Map<string, string[]>();
    for (const w of webhooksRaw) {
      const list = webhookUrlsByTenant.get(w.tenant_id) ?? [];
      list.push(w.webhook_url);
      webhookUrlsByTenant.set(w.tenant_id, list);
    }
    const apiKeyNamesByTenant = new Map<string, string[]>();
    for (const k of apiKeysRaw) {
      const list = apiKeyNamesByTenant.get(k.tenant_id) ?? [];
      list.push(k.name);
      apiKeyNamesByTenant.set(k.tenant_id, list);
    }

    // ---------- 2. Per tenant: upsert business + default profile ----------
    for (const t of tenants) {
      const source: ProfileSourceValue = classifyTenantSource(
        t.name,
        webhookUrlsByTenant.get(t.id) ?? [],
        apiKeyNamesByTenant.get(t.id) ?? [],
      );

      const slug = makeSlug(t.name, t.id);
      const displayName = (t.name ?? '').trim() || `Workspace ${t.id.slice(0, 8)}`;

      // external_business_id only populated for LeadBridge tenants
      const externalBusinessId =
        source === 'leadbridge' ? t.external_id ?? null : null;

      // Upsert business — check existence first by (tenant_id, slug)
      const businessRows: Array<{ id: string }> = await queryRunner.query(
        `SELECT id FROM communication_businesses
         WHERE tenant_id = $1 AND slug = $2 LIMIT 1`,
        [t.id, slug],
      );

      let businessId: string;
      if (businessRows.length > 0) {
        businessId = businessRows[0].id;
        // Refresh fields the migration owns; leave operator-edited fields alone
        // (status / metadata are operator-controlled, do not overwrite).
        await queryRunner.query(
          `UPDATE communication_businesses
              SET display_name = $1,
                  external_business_id = COALESCE(external_business_id, $2),
                  workspace_id = $3,
                  updated_at = now()
            WHERE id = $4`,
          [displayName, externalBusinessId, t.workspace_id, businessId],
        );
      } else {
        const inserted: Array<{ id: string }> = await queryRunner.query(
          `INSERT INTO communication_businesses
            (workspace_id, tenant_id, external_business_id, display_name, slug, status)
           VALUES ($1, $2, $3, $4, $5, 'active')
           RETURNING id`,
          [t.workspace_id, t.id, externalBusinessId, displayName, slug],
        );
        businessId = inserted[0].id;
      }

      // Upsert default profile under this business
      const profileRows: Array<{ id: string }> = await queryRunner.query(
        `SELECT id FROM communication_profiles
         WHERE communication_business_id = $1 AND slug = 'default' LIMIT 1`,
        [businessId],
      );

      let profileId: string;
      if (profileRows.length > 0) {
        profileId = profileRows[0].id;
        await queryRunner.query(
          `UPDATE communication_profiles
              SET source = $1,
                  display_name = 'Default',
                  workspace_id = $2,
                  tenant_id = $3,
                  is_default = TRUE,
                  updated_at = now()
            WHERE id = $4`,
          [source, t.workspace_id, t.id, profileId],
        );
      } else {
        const inserted: Array<{ id: string }> = await queryRunner.query(
          `INSERT INTO communication_profiles
            (workspace_id, tenant_id, communication_business_id, source,
             display_name, slug, status, is_default)
           VALUES ($1, $2, $3, $4, 'Default', 'default', 'active', TRUE)
           RETURNING id`,
          [t.workspace_id, t.id, businessId, source],
        );
        profileId = inserted[0].id;
      }

      // Pin default_profile_id on the business
      await queryRunner.query(
        `UPDATE communication_businesses
            SET default_profile_id = $1, updated_at = now()
          WHERE id = $2 AND (default_profile_id IS DISTINCT FROM $1)`,
        [profileId, businessId],
      );
    }

    // ---------- 3. profile_phone_assignments — one per tenant_phone_numbers row ----------
    //
    // A tenant can own multiple phones, but the partial-unique index
    // IDX_ppa_default_per_profile requires that ONLY ONE assignment per
    // profile carries is_default=TRUE while active. So we rank phones per
    // profile by (created_at ASC, id ASC) and mark only the first as
    // default; siblings get is_default=FALSE and rely on priority.
    //
    // Idempotent: NOT EXISTS guard against the unique
    // (profile_id, tenant_phone_number_id) index.
    await queryRunner.query(`
      WITH ranked AS (
        SELECT
          p.id   AS profile_id,
          tpn.id AS phone_id,
          ROW_NUMBER() OVER (
            PARTITION BY p.id
            ORDER BY tpn.created_at ASC, tpn.id ASC
          ) AS rn
        FROM tenant_phone_numbers tpn
        JOIN communication_profiles p
          ON p.tenant_id = tpn.tenant_id AND p.is_default = TRUE
      )
      INSERT INTO profile_phone_assignments
        (profile_id, tenant_phone_number_id, role, is_default, priority, active)
      SELECT
        r.profile_id,
        r.phone_id,
        'primary',
        (r.rn = 1),                  -- only the first per profile is the default
        100,
        TRUE
      FROM ranked r
      WHERE NOT EXISTS (
        SELECT 1 FROM profile_phone_assignments ppa
        WHERE ppa.profile_id = r.profile_id
          AND ppa.tenant_phone_number_id = r.phone_id
      )
    `);

    // ---------- 4. Backfill conversations ----------
    // Every conversation gets its tenant's default business + default profile.
    // profile_confidence = 'phone_default' so the resolver knows this was
    // mass-assigned without a sticky signal.
    await queryRunner.query(`
      UPDATE communication_conversations c
        SET communication_business_id = b.id,
            communication_profile_id  = b.default_profile_id,
            profile_confidence        = 'phone_default'
        FROM communication_businesses b
       WHERE b.tenant_id = c.tenant_id
         AND c.tenant_id IS NOT NULL
         AND c.communication_profile_id IS NULL
         AND b.default_profile_id IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse in safe order. Conversations are updated in place so the
    // down path nulls out only what we touched.
    await queryRunner.query(`
      UPDATE communication_conversations
         SET communication_business_id = NULL,
             communication_profile_id  = NULL,
             profile_confidence        = NULL
       WHERE profile_confidence = 'phone_default'
    `);

    // Delete derived junction rows. Profiles + businesses cascade-delete on
    // their FKs, so dropping profiles cascades to assignments — but we do
    // it explicitly here for clarity.
    await queryRunner.query(
      `DELETE FROM profile_phone_assignments WHERE role = 'primary' AND is_default = TRUE`,
    );

    // Clear FK pointer before deleting profiles to avoid the deferred FK trip.
    await queryRunner.query(
      `UPDATE communication_businesses SET default_profile_id = NULL`,
    );

    // Delete only auto-created rows (slug 'default') — operator-created
    // profiles stay so a re-up doesn't duplicate them.
    await queryRunner.query(
      `DELETE FROM communication_profiles WHERE slug = 'default'`,
    );

    // Delete only auto-created businesses — those whose slug ends in
    // "-<id8>" matching their tenant id. Conservative: leave operator
    // additions alone.
    await queryRunner.query(`
      DELETE FROM communication_businesses cb
      WHERE EXISTS (
        SELECT 1 FROM tenants t
         WHERE t.id = cb.tenant_id
           AND cb.slug LIKE '%-' || substring(t.id::text, 1, 8)
      )
    `);
  }
}
