#!/usr/bin/env node
/**
 * Incident 2026-07-18 — Natallia's Cleaning Services outbound-SMS repair.
 *
 * Investigation summary (see plan
 * C:\Users\HP\.claude\plans\unified-baking-thompson.md):
 *
 *   - Tenant `7493e20a-…` (Natallia) is in the shared LB workspace
 *     `1bcbb4e0-…`. TPN `+12068662232` (id `b42e1b8e-…`) was provisioned
 *     via Callio 2026-07-16 22:20 UTC — after the 2026-07-14 credential
 *     rollback but before Wave-3 fix for TPN.communication_integration_id
 *     stamping was in place. As a result TPN.communication_integration_id
 *     is NULL.
 *
 *   - ProviderContextResolver: rule 1 (by_number) falls through because
 *     the TPN is unstamped. Rule 3 (by_tenant) finds zero rows because
 *     Natallia has no tenant-scoped Twilio integration. Rule 4
 *     (workspace fallback) finds TWO active Twilio integrations for the
 *     LB workspace (`a537cc3a-…` WORKSPACE-scoped LB, `8b8cdfd2-…`
 *     TENANT-scoped Callio) → 409.
 *
 *   - Twilio API confirms PN226…5c2 (+12068662232) is owned by LB's
 *     account (AC9e62…8eba) with status "in-use". Canonical integration
 *     = `a537cc3a-5c62-4f11-aff8-50fa840ef7a2`.
 *
 *   - K&D Cleaning has the identical bug (TPN `cdb86f88-…`,
 *     +13474310965, PN920…0f6, also on AC9e62). Fixed in the same run.
 *
 *   - NO integration rows are archived / deleted / modified — this is a
 *     pure TPN + phone_number_orders stamp backfill. All partial unique
 *     indexes are correctly enforcing invariants; the miss is the stamp.
 *
 * Usage:
 *   DATABASE_URL=... node backend/scripts/_repair-natallia-2026-07-18.js --dry-run
 *   DATABASE_URL=... node backend/scripts/_repair-natallia-2026-07-18.js --apply
 *
 * Reversible via the rollback SQL emitted to %LOCALAPPDATA%\Temp\.
 */

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CANONICAL_INTEGRATION = 'a537cc3a-5c62-4f11-aff8-50fa840ef7a2';
const LB_WORKSPACE           = '1bcbb4e0-df1b-481c-83ba-0730df47a720';

const TARGETS = [
  {
    label: 'Natallia’s Cleaning Services',
    tenantId: '7493e20a-7555-41ac-b215-195840470050',
    tpnId:    'b42e1b8e-9b34-4403-97a0-42cf81db5e81',
    phone:    '+12068662232',
    orderId:  '23fcc3d0-8b34-4c5e-8371-b19d02496c58',
  },
  {
    label: 'K&D Cleaning',
    tenantId: '7facf4c2-0f4b-4a7c-a93f-07025abff45c',
    tpnId:    'cdb86f88-2713-44b3-abfb-af4a035f8ef0',
    phone:    '+13474310965',
    orderId:  null,   // resolved from tenant_phone_number_id at runtime
  },
];

const OUT_DIR = process.env.TEMP || os.tmpdir();
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const PRE  = path.join(OUT_DIR, `natallia-pre-${ts}.json`);
const POST = path.join(OUT_DIR, `natallia-post-${ts}.json`);
const RBK  = path.join(OUT_DIR, `natallia-rollback-${ts}.sql`);

const ARGS   = new Set(process.argv.slice(2));
const APPLY  = ARGS.has('--apply');
const DRY    = !APPLY;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL missing'); process.exit(1);
}

async function main() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    // -------- Pre-state snapshot (also serves as safety check) --------
    const pre = {};
    for (const t of TARGETS) {
      const tpn = (await c.query(
        `SELECT id, workspace_id, tenant_id, phone_number, provider,
                provider_id, communication_integration_id, status,
                metadata, provisioned_via_callio, provisioned_at
         FROM tenant_phone_numbers WHERE id = $1`, [t.tpnId])).rows[0];
      const orderRow = (await c.query(
        `SELECT id, tenant_id, phone_number, communication_integration_id, status
         FROM phone_number_orders
         WHERE tenant_phone_number_id = $1 OR id = $2`,
         [t.tpnId, t.orderId])).rows[0];
      const wsIntegrations = (await c.query(
        `SELECT id, provider, scope_type, owner_tenant_id, status, LEFT(external_workspace_id, 12) AS acct_prefix
         FROM communication_integrations
         WHERE workspace_id = $1 AND provider = 'twilio' AND status = 'active'
         ORDER BY scope_type, created_at`, [LB_WORKSPACE])).rows;
      pre[t.tenantId] = { label: t.label, tpn, orderRow, wsIntegrations };
    }
    fs.writeFileSync(PRE, JSON.stringify(pre, null, 2));

    // -------- Safety checks --------
    for (const t of TARGETS) {
      const s = pre[t.tenantId];
      if (!s.tpn) throw new Error(`[SAFETY] ${t.label}: TPN ${t.tpnId} not found`);
      if (s.tpn.phone_number !== t.phone)
        throw new Error(`[SAFETY] ${t.label}: TPN phone mismatch (db=${s.tpn.phone_number}, expected=${t.phone})`);
      if (s.tpn.workspace_id !== LB_WORKSPACE)
        throw new Error(`[SAFETY] ${t.label}: TPN workspace mismatch (db=${s.tpn.workspace_id}, expected=${LB_WORKSPACE})`);
      if (s.tpn.communication_integration_id) {
        console.log(`[SKIP] ${t.label}: TPN already stamped with ${s.tpn.communication_integration_id}. Nothing to do.`);
        t._skip = true;
      }
      const canon = s.wsIntegrations.find(i => i.id === CANONICAL_INTEGRATION);
      if (!canon)
        throw new Error(`[SAFETY] ${t.label}: canonical integration ${CANONICAL_INTEGRATION} not present or not active in workspace`);
    }

    // -------- Plan output --------
    console.log('');
    console.log('=== REPAIR PLAN ===');
    console.log(`mode: ${DRY ? 'DRY-RUN (no writes)' : 'APPLY'}`);
    console.log(`pre-state snapshot: ${PRE}`);
    console.log('');
    for (const t of TARGETS) {
      if (t._skip) continue;
      const s = pre[t.tenantId];
      console.log(`- ${t.label}`);
      console.log(`    UPDATE tenant_phone_numbers SET communication_integration_id = '${CANONICAL_INTEGRATION}'`);
      console.log(`      WHERE id = '${t.tpnId}';   -- ${t.phone}, currently NULL`);
      if (s.orderRow && !s.orderRow.communication_integration_id) {
        console.log(`    UPDATE phone_number_orders SET communication_integration_id = '${CANONICAL_INTEGRATION}'`);
        console.log(`      WHERE id = '${s.orderRow.id}';   -- currently NULL`);
      }
      console.log('');
    }

    if (DRY) {
      console.log('DRY-RUN complete. Re-run with --apply to execute.');
      return;
    }

    // -------- Rollback SQL emitted BEFORE we write --------
    const rbkLines = ['BEGIN;'];
    for (const t of TARGETS) {
      if (t._skip) continue;
      const s = pre[t.tenantId];
      rbkLines.push(`UPDATE tenant_phone_numbers SET communication_integration_id = ${s.tpn.communication_integration_id === null ? 'NULL' : `'${s.tpn.communication_integration_id}'`} WHERE id = '${t.tpnId}';`);
      if (s.orderRow) {
        rbkLines.push(`UPDATE phone_number_orders SET communication_integration_id = ${s.orderRow.communication_integration_id === null ? 'NULL' : `'${s.orderRow.communication_integration_id}'`} WHERE id = '${s.orderRow.id}';`);
      }
    }
    rbkLines.push('COMMIT;');
    fs.writeFileSync(RBK, rbkLines.join('\n') + '\n');
    console.log(`rollback SQL written to: ${RBK}`);
    console.log('');

    // -------- Apply in a single transaction --------
    await c.query('BEGIN');
    for (const t of TARGETS) {
      if (t._skip) continue;
      const s = pre[t.tenantId];
      await c.query(
        `UPDATE tenant_phone_numbers SET communication_integration_id = $1, updated_at = NOW() WHERE id = $2`,
        [CANONICAL_INTEGRATION, t.tpnId]);
      if (s.orderRow && !s.orderRow.communication_integration_id) {
        await c.query(
          `UPDATE phone_number_orders SET communication_integration_id = $1, updated_at = NOW() WHERE id = $2`,
          [CANONICAL_INTEGRATION, s.orderRow.id]);
      }
    }
    await c.query('COMMIT');

    // -------- Post-state snapshot + resolver simulation --------
    const post = {};
    for (const t of TARGETS) {
      if (t._skip) { post[t.tenantId] = { label: t.label, skipped: true }; continue; }
      const tpn = (await c.query(
        `SELECT id, communication_integration_id FROM tenant_phone_numbers WHERE id = $1`, [t.tpnId])).rows[0];
      const orderRow = t.orderId ? (await c.query(
        `SELECT id, communication_integration_id FROM phone_number_orders WHERE id = $1`, [t.orderId])).rows[0] : null;
      post[t.tenantId] = { label: t.label, tpn, orderRow };
      if (tpn.communication_integration_id !== CANONICAL_INTEGRATION) {
        throw new Error(`[POST-CHECK] ${t.label}: TPN did not stamp to canonical id — got ${tpn.communication_integration_id}`);
      }
    }
    fs.writeFileSync(POST, JSON.stringify(post, null, 2));
    console.log(`post-state snapshot: ${POST}`);
    console.log('');
    console.log('REPAIR APPLIED. Rollback available at:', RBK);
  } catch (err) {
    try { await c.query('ROLLBACK'); } catch {}
    console.error('REPAIR FAILED:', err.message);
    process.exit(2);
  } finally {
    await c.end();
  }
}

main();
