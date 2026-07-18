#!/usr/bin/env node
/**
 * Incident 2026-07-18 Wave-3 completion — provider-context audit CLI.
 *
 * Prints the same four-section report that
 * `GET /admin/provider-context/audit` returns. Uses raw SQL (no NestJS
 * bootstrap) so it can be executed against any DATABASE_URL (staging,
 * prod, or a local snapshot) without booting the app.
 *
 * Usage:
 *   DATABASE_URL=... node backend/scripts/audit-provider-context.js
 *   DATABASE_URL=... node backend/scripts/audit-provider-context.js --workspace <uuid>
 *   DATABASE_URL=... node backend/scripts/audit-provider-context.js --tenant <uuid>
 *   DATABASE_URL=... node backend/scripts/audit-provider-context.js --phone +1XXXXXXXXXX
 *   DATABASE_URL=... node backend/scripts/audit-provider-context.js --json
 *
 * Exit codes:
 *   0 — no issues found (or filters returned nothing)
 *   1 — at least one section is non-empty; details printed
 *   2 — invocation error
 */

const { Client } = require('pg');

function parseArgs(argv) {
  const out = { workspaceId: null, tenantId: null, phone: null, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workspace' || a === '--workspaceId') out.workspaceId = argv[++i];
    else if (a === '--tenant' || a === '--tenantId') out.tenantId = argv[++i];
    else if (a === '--phone') out.phone = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node audit-provider-context.js [--workspace <uuid>] [--tenant <uuid>] [--phone +1XXX...] [--json]');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

async function q(c, sql, params) {
  const r = await c.query(sql, params);
  return r.rows;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(2); }

  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    // 1. Duplicate integrations
    const dupWhere = args.workspaceId ? `AND workspace_id = $1` : '';
    const dupParams = args.workspaceId ? [args.workspaceId] : [];
    const duplicates = await q(c, `
      SELECT
        workspace_id::text AS "workspaceId", provider, scope_type AS "scopeType",
        owner_tenant_id::text AS "ownerTenantId", COUNT(*)::int AS "count",
        ARRAY_AGG(id::text ORDER BY created_at) AS "integrationIds"
      FROM communication_integrations
      WHERE status = 'active' ${dupWhere}
      GROUP BY workspace_id, provider, scope_type, owner_tenant_id
      HAVING COUNT(*) > 1
      ORDER BY workspace_id, provider
    `, dupParams);

    // 2. Unstamped TPNs
    const wheres = [`status = 'active'`, `communication_integration_id IS NULL`];
    const params = [];
    if (args.workspaceId) { params.push(args.workspaceId); wheres.push(`workspace_id = $${params.length}`); }
    if (args.tenantId)    { params.push(args.tenantId);    wheres.push(`tenant_id = $${params.length}`); }
    if (args.phone)       { params.push(args.phone);       wheres.push(`phone_number = $${params.length}`); }
    const unstamped = await q(c, `
      SELECT id::text, workspace_id::text AS "workspaceId", tenant_id::text AS "tenantId",
             phone_number AS "phoneNumber", provider, status
      FROM tenant_phone_numbers
      WHERE ${wheres.join(' AND ')}
      ORDER BY workspace_id, tenant_id, phone_number
    `, params);

    // 3. Legacy workspace rows
    const legacyWhere = args.workspaceId ? `AND workspace_id = $1` : '';
    const legacyParams = args.workspaceId ? [args.workspaceId] : [];
    const legacy = await q(c, `
      SELECT id::text, workspace_id::text AS "workspaceId", provider,
             (metadata->'ensure'->>'tenantId') AS "metadataEnsureTenantId",
             created_at AS "createdAt"
      FROM communication_integrations
      WHERE status = 'active'
        AND owner_tenant_id IS NULL
        AND (metadata->'ensure'->>'tenantId') IS NOT NULL
        ${legacyWhere}
      ORDER BY workspace_id, created_at
    `, legacyParams);

    // 4. Tenants without chain
    const chainWheres = [`tpn.status = 'active'`, `tpn.tenant_id IS NOT NULL`];
    const chainParams = [];
    if (args.workspaceId) { chainParams.push(args.workspaceId); chainWheres.push(`tpn.workspace_id = $${chainParams.length}`); }
    if (args.tenantId)    { chainParams.push(args.tenantId);    chainWheres.push(`tpn.tenant_id = $${chainParams.length}`); }
    const chains = await q(c, `
      WITH tenants_with_tpn AS (
        SELECT DISTINCT tpn.tenant_id, tpn.workspace_id
        FROM tenant_phone_numbers tpn
        WHERE ${chainWheres.join(' AND ')}
      )
      SELECT
        t.tenant_id::text AS "tenantId",
        t.workspace_id::text AS "workspaceId",
        EXISTS (SELECT 1 FROM communication_businesses b WHERE b.tenant_id = t.tenant_id) AS "hasBusiness",
        EXISTS (SELECT 1 FROM communication_profiles p WHERE p.tenant_id = t.tenant_id) AS "hasProfile",
        EXISTS (
          SELECT 1 FROM profile_phone_assignments ppa
          JOIN communication_profiles p ON p.id = ppa.profile_id
          WHERE p.tenant_id = t.tenant_id AND ppa.active = TRUE
        ) AS "hasPpa"
      FROM tenants_with_tpn t
      WHERE NOT EXISTS (SELECT 1 FROM communication_businesses b WHERE b.tenant_id = t.tenant_id)
         OR NOT EXISTS (SELECT 1 FROM communication_profiles p WHERE p.tenant_id = t.tenant_id)
         OR NOT EXISTS (
              SELECT 1 FROM profile_phone_assignments ppa
              JOIN communication_profiles p ON p.id = ppa.profile_id
              WHERE p.tenant_id = t.tenant_id AND ppa.active = TRUE
            )
      ORDER BY t.workspace_id, t.tenant_id
    `, chainParams);

    const report = {
      ts: new Date().toISOString(),
      filters: { workspaceId: args.workspaceId, tenantId: args.tenantId, phone: args.phone },
      counts: {
        duplicateIntegrations: duplicates.length,
        unstampedTpns: unstamped.length,
        legacyWorkspaceRows: legacy.length,
        tenantsWithoutChain: chains.length,
      },
      duplicateIntegrations: duplicates,
      unstampedTpns: unstamped,
      legacyWorkspaceRows: legacy,
      tenantsWithoutChain: chains,
    };

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      const cn = report.counts;
      console.log(`=== provider-context audit ${report.ts} ===`);
      console.log(`filters:`, report.filters);
      console.log('');
      console.log(`  duplicate_integrations: ${cn.duplicateIntegrations}`);
      console.log(`  unstamped_tpns:         ${cn.unstampedTpns}`);
      console.log(`  legacy_workspace_rows:  ${cn.legacyWorkspaceRows}`);
      console.log(`  tenants_without_chain:  ${cn.tenantsWithoutChain}`);
      console.log('');
      for (const [label, rows] of [
        ['duplicate_integrations', duplicates],
        ['unstamped_tpns',         unstamped],
        ['legacy_workspace_rows',  legacy],
        ['tenants_without_chain',  chains],
      ]) {
        if (rows.length === 0) continue;
        console.log(`--- ${label} (${rows.length}) ---`);
        for (const row of rows) console.log('  ' + JSON.stringify(row));
        console.log('');
      }
    }

    const hasIssues =
      duplicates.length + unstamped.length + legacy.length + chains.length > 0;
    process.exit(hasIssues ? 1 : 0);
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
