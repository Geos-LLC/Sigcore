/* eslint-disable */
// Sigcore-side data repair for 3 tenant/phone bindings that 422 on outbound send.
//
// Per active tenant, in one transaction:
//   1. INSERT communication_businesses  (idempotent by (tenant_id, slug))
//   2. INSERT communication_profiles     (idempotent by (business_id, slug='default'))
//   3. UPDATE business.default_profile_id
//   4. INSERT profile_phone_assignments  (idempotent by (profile_id, tpn_id))
//
// Rows are inserted only when missing. Each row that IS created is logged
// so the run's before/after can be reconstructed.
//
// Root-cause context: only PhoneNumberProvisioningService.purchaseNumber
// calls ensureOutboundReadyForTenantPhone today. Every other TPN-write
// path (reallocatePhoneNumber, tenants.service.allocatePhoneNumber, etc.)
// leaves partial state — see the audit table in Callio.md 2026-07-13.
// Follow-up code PR wires ensureOutboundReady into those paths.
//
// Usage (dry-run):
//   DATABASE_URL=$(node -e "console.log(require('../../../Leadbridge-workspace/Leadbridge/sigcore-prod-vars.json').data.variables.DATABASE_URL)") \
//     DRY_RUN=1 node backend/scripts/_fix-3-broken-tenants-2026-07-13.js
//
// Usage (commit):
//   DATABASE_URL=... node backend/scripts/_fix-3-broken-tenants-2026-07-13.js

const { Client } = require('pg');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL first.');
  process.exit(1);
}
const DRY_RUN = process.env.DRY_RUN === '1';

const WORKSPACE_ID = '1bcbb4e0-df1b-481c-83ba-0730df47a720';

const TARGETS = [
  {
    label: 'Spotless 360Cleaning',
    tenantId: '7d5e2ec4-85b3-4338-acfe-f87a2718a8f3',
    tpnId: '0a0a5951-d092-4781-8074-61cac06f5551',
    phoneE164: '+19045778584',
  },
  {
    label: 'Spotless Georgiy Sayapin',
    tenantId: 'fea3c5a1-f0e7-4f00-9906-e870620770ef',
    tpnId: '0a0a5951-d092-4781-8074-61cac06f5551',
    phoneE164: '+19045778584',
  },
  {
    label: 'NatashaHome Cleaning',
    tenantId: '8f6f869d-abe3-42cf-b9c0-dada66696c78',
    tpnId: 'f73bbf27-58a1-4b1d-a2b1-3b8f5c8a4c9e', // resolved below from probe (may differ, verified in TPN sanity)
    phoneE164: '+15013832064',
  },
];

function slugify(name, id) {
  const base = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace';
  return `${base}-${id.slice(0, 8)}`;
}
function short(u) { return u ? u.slice(0, 8) : u; }

(async () => {
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();

  // Verify each TPN exists, is in the expected workspace, and is active.
  for (const t of TARGETS) {
    const tpn = await c.query(
      `SELECT id, phone_number, workspace_id, tenant_id, status
       FROM tenant_phone_numbers WHERE workspace_id = $1 AND phone_number = $2 LIMIT 1`,
      [WORKSPACE_ID, t.phoneE164],
    );
    if (tpn.rows.length === 0) throw new Error(`TPN ${t.phoneE164} not found in workspace ${WORKSPACE_ID}`);
    // Rebind tpnId from what we actually found — canonical source of truth.
    t.tpnId = tpn.rows[0].id;
    if (tpn.rows[0].status !== 'active') {
      throw new Error(`TPN ${t.phoneE164} status=${tpn.rows[0].status} — refusing to bind`);
    }
    console.log(`sanity ok: TPN ${t.phoneE164} = ${short(t.tpnId)} (owner tenant ${short(tpn.rows[0].tenant_id)})`);
  }

  const created = { businesses: [], profiles: [], ppas: [] };

  await c.query('BEGIN');
  try {
    for (const t of TARGETS) {
      // Fetch tenant fields we need (name + external_id) so we build the
      // display_name/slug/external_business_id consistently with the LB
      // fix template used on the July 13 Spotless batch.
      const trow = (await c.query(
        `SELECT name, external_id FROM tenants WHERE id = $1`,
        [t.tenantId],
      )).rows[0];
      if (!trow) throw new Error(`tenant ${t.tenantId} not found`);

      const displayName = (trow.name || '').trim() || `Workspace ${t.tenantId.slice(0, 8)}`;
      const slug = slugify(trow.name, t.tenantId);
      const externalBizId = trow.external_id ?? null;

      console.log(`\n${t.label} [${short(t.tenantId)}]`);

      // 1. business (upsert by (tenant_id, slug))
      let bizId;
      const existingBiz = await c.query(
        `SELECT id FROM communication_businesses WHERE tenant_id = $1 AND slug = $2 LIMIT 1`,
        [t.tenantId, slug],
      );
      if (existingBiz.rows.length > 0) {
        bizId = existingBiz.rows[0].id;
        console.log(`  business exists (${short(bizId)})`);
      } else {
        const ins = await c.query(
          `INSERT INTO communication_businesses
             (workspace_id, tenant_id, external_business_id, display_name, slug, status)
           VALUES ($1, $2, $3, $4, $5, 'active') RETURNING id`,
          [WORKSPACE_ID, t.tenantId, externalBizId, displayName, slug],
        );
        bizId = ins.rows[0].id;
        created.businesses.push(bizId);
        console.log(`  INSERTED business ${bizId} (slug='${slug}')`);
      }

      // 2. profile (default)
      let profId;
      const existingProf = await c.query(
        `SELECT id FROM communication_profiles WHERE communication_business_id = $1 AND slug = 'default' LIMIT 1`,
        [bizId],
      );
      if (existingProf.rows.length > 0) {
        profId = existingProf.rows[0].id;
        console.log(`    profile exists (${short(profId)})`);
      } else {
        const ins = await c.query(
          `INSERT INTO communication_profiles
             (workspace_id, tenant_id, communication_business_id, source, display_name, slug, status, is_default)
           VALUES ($1, $2, $3, 'leadbridge', 'Default', 'default', 'active', TRUE) RETURNING id`,
          [WORKSPACE_ID, t.tenantId, bizId],
        );
        profId = ins.rows[0].id;
        created.profiles.push(profId);
        console.log(`    INSERTED profile ${profId}`);
      }

      // 3. pin default_profile_id
      const pinned = await c.query(
        `UPDATE communication_businesses SET default_profile_id = $1, updated_at = now()
         WHERE id = $2 AND (default_profile_id IS DISTINCT FROM $1) RETURNING id`,
        [profId, bizId],
      );
      if (pinned.rowCount > 0) {
        console.log(`    pinned business.default_profile_id -> ${short(profId)}`);
      }

      // 4. PPA
      const existingPpa = await c.query(
        `SELECT id, active FROM profile_phone_assignments
         WHERE profile_id = $1 AND tenant_phone_number_id = $2 LIMIT 1`,
        [profId, t.tpnId],
      );
      if (existingPpa.rows.length > 0) {
        if (existingPpa.rows[0].active) {
          console.log(`    PPA already active (${short(existingPpa.rows[0].id)})`);
        } else {
          await c.query(
            `UPDATE profile_phone_assignments
             SET active = TRUE, role = 'primary', is_default = TRUE, priority = 100, updated_at = now()
             WHERE id = $1`,
            [existingPpa.rows[0].id],
          );
          console.log(`    PPA reactivated (${short(existingPpa.rows[0].id)})`);
        }
      } else {
        const ins = await c.query(
          `INSERT INTO profile_phone_assignments
             (profile_id, tenant_phone_number_id, role, is_default, priority, active)
           VALUES ($1, $2, 'primary', TRUE, 100, TRUE) RETURNING id`,
          [profId, t.tpnId],
        );
        created.ppas.push(ins.rows[0].id);
        console.log(`    INSERTED PPA ${ins.rows[0].id} -> TPN ${short(t.tpnId)}`);
      }
    }

    if (DRY_RUN) {
      console.log('\nDRY_RUN=1 — rolling back');
      await c.query('ROLLBACK');
    } else {
      await c.query('COMMIT');
      console.log('\nCOMMIT ok');
    }

    console.log('\nSummary:');
    console.log(`  businesses inserted: ${created.businesses.length}   ${JSON.stringify(created.businesses)}`);
    console.log(`  profiles inserted:   ${created.profiles.length}   ${JSON.stringify(created.profiles)}`);
    console.log(`  PPAs inserted:       ${created.ppas.length}   ${JSON.stringify(created.ppas)}`);
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
})().catch((e) => {
  console.error('ERROR:', e.message);
  console.error(e.stack);
  process.exit(1);
});
