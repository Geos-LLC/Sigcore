/* eslint-disable */
// Read-only probe for the 3 tenant/phone bindings that 422 on outbound send.
//
// For each (tenant, phone) pair we report:
//   1. tenant row (workspace, name, external_id, status)
//   2. tenant_phone_numbers row (workspace, tenant_id, status, a2p_status)
//   3. communication_businesses row for that tenant (by tenant_id, all slugs)
//   4. communication_profiles rows under each business
//   5. profile_phone_assignments rows linking profile -> TPN
//   6. Exact Step-B outbound resolver query result (row count)
//
// No writes. Reads only. Safe to run any time.
//
// Usage:
//   DATABASE_URL=$(node -e "console.log(require('../../../Leadbridge-workspace/Leadbridge/sigcore-prod-vars.json').data.variables.DATABASE_URL)") \
//     node backend/scripts/_probe-3-broken-tenants-2026-07-13.js

const { Client } = require('pg');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL first.');
  process.exit(1);
}

const TARGETS = [
  {
    label: 'Spotless 360Cleaning',
    tenantId: '7d5e2ec4-85b3-4338-acfe-f87a2718a8f3',
    phoneE164: '+19045778584',
  },
  {
    label: 'Spotless Georgiy Sayapin brand',
    tenantId: 'fea3c5a1-f0e7-4f00-9906-e870620770ef',
    phoneE164: '+19045778584',
  },
  {
    label: 'Natasha Home Cleaning',
    tenantId: '8f6f869d-abe3-42cf-b9c0-dada66696c78',
    phoneE164: '+15013832064',
  },
];

function short(uuid) {
  return uuid ? uuid.slice(0, 8) : uuid;
}

(async () => {
  const c = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();

  for (const t of TARGETS) {
    console.log('\n============================================================');
    console.log(`${t.label}`);
    console.log(`  tenant=${t.tenantId}  phone=${t.phoneE164}`);
    console.log('============================================================');

    // 1. tenant
    const tenant = await c.query(
      `SELECT id, workspace_id, name, external_id, status, created_at
       FROM tenants WHERE id = $1`,
      [t.tenantId],
    );
    if (tenant.rows.length === 0) {
      console.log('  ❌ tenant row NOT FOUND — abort further probes for this row');
      continue;
    }
    const trow = tenant.rows[0];
    console.log(`  tenant: workspace=${short(trow.workspace_id)} name="${trow.name}" ext=${trow.external_id} status=${trow.status} created=${trow.created_at.toISOString().slice(0,10)}`);

    // 2. TPN
    const tpn = await c.query(
      `SELECT id, workspace_id, tenant_id, phone_number, status, a2p_status, provider,
              provider_id, provisioned_at, is_default, channel
       FROM tenant_phone_numbers
       WHERE workspace_id = $1 AND phone_number = $2`,
      [trow.workspace_id, t.phoneE164],
    );
    if (tpn.rows.length === 0) {
      console.log(`  ❌ TPN ${t.phoneE164} NOT FOUND in workspace ${short(trow.workspace_id)}`);
      continue;
    }
    for (const p of tpn.rows) {
      console.log(`  TPN: id=${short(p.id)} tenant=${short(p.tenant_id)} status=${p.status} a2p=${p.a2p_status ?? 'null'} channel=${p.channel} provider=${p.provider} providerId=${p.provider_id}`);
    }
    const tpnRow = tpn.rows[0];

    // 3. communication_businesses for this tenant (any slug)
    const biz = await c.query(
      `SELECT id, workspace_id, tenant_id, display_name, slug, status, default_profile_id, external_business_id, created_at
       FROM communication_businesses
       WHERE tenant_id = $1
       ORDER BY created_at`,
      [t.tenantId],
    );
    if (biz.rows.length === 0) {
      console.log(`  ❌ communication_businesses: 0 rows for tenant ${short(t.tenantId)} (this alone will 422)`);
    } else {
      for (const b of biz.rows) {
        console.log(`  business: id=${short(b.id)} slug=${b.slug} status=${b.status} defaultProfile=${short(b.default_profile_id)}`);
      }
    }

    // 4. profiles per business
    for (const b of biz.rows) {
      const prof = await c.query(
        `SELECT id, workspace_id, tenant_id, communication_business_id, slug, source, is_default, status, created_at
         FROM communication_profiles
         WHERE communication_business_id = $1
         ORDER BY created_at`,
        [b.id],
      );
      if (prof.rows.length === 0) {
        console.log(`    ❌ profiles under business ${short(b.id)}: 0`);
      } else {
        for (const p of prof.rows) {
          console.log(`    profile: id=${short(p.id)} slug=${p.slug} source=${p.source} isDefault=${p.is_default} status=${p.status}`);
        }
      }

      // 5. PPAs per profile
      for (const p of prof.rows) {
        const ppas = await c.query(
          `SELECT ppa.id, ppa.profile_id, ppa.tenant_phone_number_id, ppa.role, ppa.is_default, ppa.priority, ppa.active, tpn.phone_number
           FROM profile_phone_assignments ppa
           LEFT JOIN tenant_phone_numbers tpn ON tpn.id = ppa.tenant_phone_number_id
           WHERE ppa.profile_id = $1`,
          [p.id],
        );
        if (ppas.rows.length === 0) {
          console.log(`      ❌ PPAs on profile ${short(p.id)}: 0`);
        } else {
          for (const a of ppas.rows) {
            console.log(`      PPA: id=${short(a.id)} tpn=${a.phone_number} role=${a.role} isDefault=${a.is_default} priority=${a.priority} active=${a.active}`);
          }
        }
      }
    }

    // 6. EXACT resolver Step-B query
    const resolver = await c.query(
      `SELECT ppa.id AS ppa_id, ppa.profile_id, p.communication_business_id AS business_id, p.tenant_id AS profile_tenant, p.status AS profile_status, ppa.active
       FROM profile_phone_assignments ppa
       INNER JOIN tenant_phone_numbers tpn ON tpn.id = ppa.tenant_phone_number_id
       INNER JOIN communication_profiles p  ON p.id  = ppa.profile_id
       WHERE tpn.phone_number = $1
         AND p.tenant_id      = $2
         AND ppa.active       = TRUE`,
      [t.phoneE164, t.tenantId],
    );
    if (resolver.rows.length === 0) {
      console.log(`  🔴 RESOLVER Step-B: 0 matches -> outbound 422 INVALID_PROFILE_PHONE`);
    } else if (resolver.rows.length === 1) {
      const r = resolver.rows[0];
      console.log(`  ✅ RESOLVER Step-B: 1 match  ppa=${short(r.ppa_id)} profile=${short(r.profile_id)} biz=${short(r.business_id)}`);
    } else {
      console.log(`  ⚠️  RESOLVER Step-B: ${resolver.rows.length} matches -> outbound 422 AMBIGUOUS_FROM_NUMBER`);
    }
  }

  // Cross-check: is +19045778584 attached to any other active tenant in the shared workspace?
  console.log('\n============================================================');
  console.log('Cross-tenant shared-sender inventory: +19045778584 in Spotless workspace');
  console.log('============================================================');
  const shared = await c.query(
    `SELECT tpn.id, tpn.tenant_id, t.name, t.status AS tenant_status, tpn.status AS tpn_status
     FROM tenant_phone_numbers tpn
     LEFT JOIN tenants t ON t.id = tpn.tenant_id
     WHERE tpn.phone_number = '+19045778584'
     ORDER BY tpn.tenant_id`,
  );
  for (const r of shared.rows) {
    console.log(`  tpn=${short(r.id)}  owner_tenant=${short(r.tenant_id)}  tenant.status=${r.tenant_status}  tpn.status=${r.tpn_status}  name="${r.name}"`);
  }

  console.log('\n============================================================');
  console.log('Cross-tenant shared-sender inventory: +15013832064');
  console.log('============================================================');
  const shared2 = await c.query(
    `SELECT tpn.id, tpn.tenant_id, tpn.workspace_id, t.name, t.status AS tenant_status, tpn.status AS tpn_status
     FROM tenant_phone_numbers tpn
     LEFT JOIN tenants t ON t.id = tpn.tenant_id
     WHERE tpn.phone_number = '+15013832064'
     ORDER BY tpn.tenant_id`,
  );
  for (const r of shared2.rows) {
    console.log(`  tpn=${short(r.id)}  workspace=${short(r.workspace_id)}  owner_tenant=${short(r.tenant_id)}  tenant.status=${r.tenant_status}  tpn.status=${r.tpn_status}  name="${r.name}"`);
  }

  await c.end();
  console.log('\ndone.');
})().catch((e) => {
  console.error('ERROR:', e.message);
  console.error(e.stack);
  process.exit(1);
});
