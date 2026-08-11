#!/usr/bin/env node
/**
 * Issue #50 cleanup — Layer 3.
 *
 * Iterates OpenPhone-provider `communication_calls` rows in a workspace,
 * verifies each against the workspace's OWN OpenPhone API key, and
 * classifies:
 *   200 → legitimate, leave alone
 *   403 → verified-foreign (cross-workspace leak — DELETE)
 *   404 → deleted upstream (not necessarily foreign — SKIP, log for review)
 *   other → SKIP, log for review
 *
 * Also prints a Layer 2 check up front:
 *   - workspaces.webhook_id uniqueness (asserts every URL fragment maps to
 *     exactly one workspace — the ticket's second candidate root cause)
 *
 * Usage:
 *   DATABASE_URL=… ENCRYPTION_KEY=… node backend/scripts/cleanup-openphone-foreign-events-2026-08-10.js
 *   ...                                                                                                --workspace <uuid>
 *   ...                                                                                                --workspace <uuid> --limit 50
 *   ...                                                                                                --workspace <uuid> --commit
 *
 * Env:
 *   DATABASE_URL   (required)  Postgres connection string
 *   ENCRYPTION_KEY (required)  same value the app uses (from AWS Secrets)
 *
 * Flags:
 *   --workspace <uuid>  Restrict verification to one workspace. Recommended
 *                        for the first run so you can eyeball the output.
 *   --limit <n>         Max calls to verify per workspace (rate-limit guard).
 *                        Default: 1000. Use a small number for a smoke test.
 *   --commit            Actually DELETE verified-foreign rows. Otherwise dry-run.
 *   --json              Emit machine-readable JSON summary instead of text.
 *
 * Exit codes:
 *   0 — completed (may have found + reported foreign rows in dry-run)
 *   1 — completed with deletions applied (--commit)
 *   2 — invocation / connection / env error
 */

const { Client } = require('pg');
const CryptoJS = require('crypto-js');

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { workspaceId: null, limit: 1000, commit: false, json: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workspace' || a === '--workspaceId') out.workspaceId = argv[++i];
    else if (a === '--limit') out.limit = parseInt(argv[++i], 10);
    else if (a === '--commit') out.commit = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error(`Unknown argument: ${a}`); process.exit(2); }
  }
  return out;
}

function printHelp() {
  console.log(`Usage:
  DATABASE_URL=… ENCRYPTION_KEY=… node cleanup-openphone-foreign-events-2026-08-10.js
    [--workspace <uuid>] [--limit N] [--commit] [--json]

Dry-run by default. See file header for full docs.`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function decrypt(encryptedData, key) {
  const bytes = CryptoJS.AES.decrypt(encryptedData, key);
  return bytes.toString(CryptoJS.enc.Utf8);
}

async function q(c, sql, params) { return (await c.query(sql, params)).rows; }

async function fetchJson(url, headers) {
  // Node 18+ has global fetch; script is CJS but that's fine.
  const res = await fetch(url, { headers });
  const status = res.status;
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  return { status, body };
}

// ---------------------------------------------------------------------------
// Layer 2 — webhook_id uniqueness on workspaces
// ---------------------------------------------------------------------------
async function checkWebhookIdUniqueness(c) {
  const rows = await q(c, `
    SELECT webhook_id, COUNT(*)::int AS n, array_agg(id) AS workspace_ids
    FROM workspaces
    WHERE webhook_id IS NOT NULL
    GROUP BY webhook_id
    HAVING COUNT(*) > 1
    ORDER BY n DESC;
  `);
  return rows;
}

// ---------------------------------------------------------------------------
// Fetch this workspace's owned phone number IDs from OpenPhone.
// ---------------------------------------------------------------------------
async function getOwnedPhoneNumberIds(apiKey) {
  const { status, body } = await fetchJson(
    'https://api.openphone.com/v1/phone-numbers',
    { Authorization: apiKey, 'Content-Type': 'application/json' },
  );
  if (status !== 200) throw new Error(`GET /v1/phone-numbers → ${status}`);
  return new Set((body?.data ?? []).map((p) => p.id));
}

// ---------------------------------------------------------------------------
// Verify one call ID against OpenPhone using this workspace's key.
// ---------------------------------------------------------------------------
async function verifyCall(apiKey, providerCallId) {
  const { status } = await fetchJson(
    `https://api.openphone.com/v1/calls/${encodeURIComponent(providerCallId)}`,
    { Authorization: apiKey, 'Content-Type': 'application/json' },
  );
  if (status === 200) return 'owned';
  if (status === 403) return 'foreign';
  if (status === 404) return 'missing';
  return `http-${status}`;
}

// ---------------------------------------------------------------------------
// Per-workspace scan
// ---------------------------------------------------------------------------
async function scanWorkspace(c, wsId, encryptionKey, limit) {
  // 1) Decrypt the workspace's OpenPhone key
  const integrations = await q(
    c,
    `SELECT credentials_encrypted FROM communication_integrations
      WHERE workspace_id = $1 AND provider = 'openphone'
      LIMIT 1`,
    [wsId],
  );
  if (integrations.length === 0) {
    return { skipped: true, reason: 'no openphone integration' };
  }
  let apiKey;
  try {
    const cleartext = decrypt(integrations[0].credentials_encrypted, encryptionKey);
    apiKey = JSON.parse(cleartext).apiKey;
    if (!apiKey) throw new Error('missing apiKey in credentials');
  } catch (e) {
    return { skipped: true, reason: `decrypt failed: ${e.message}` };
  }

  // 2) Owned phone number IDs (for a cheap short-circuit — calls whose
  //    conversation metadata phoneNumberId is in the owned set are trusted
  //    without a per-call round trip).
  let owned;
  try { owned = await getOwnedPhoneNumberIds(apiKey); }
  catch (e) { return { skipped: true, reason: `list /phone-numbers failed: ${e.message}` }; }

  // 3) OpenPhone calls whose conversation carries a phoneNumberId in its
  //    metadata that is NOT in the workspace's owned set. Also include calls
  //    whose parent conversation looks orphan-ish (empty participant or
  //    empty phone).
  const suspect = await q(
    c,
    `SELECT cc.id, cc.provider_call_id, cc.conversation_id, cc.created_at,
            conv.metadata->>'phoneNumberId' AS phone_number_id,
            conv.participant_phone_number,
            conv.phone_number AS conv_phone
       FROM communication_calls cc
       JOIN communication_conversations conv ON conv.id = cc.conversation_id
      WHERE conv.workspace_id = $1
        AND conv.provider = 'openphone'
        AND cc.provider_call_id IS NOT NULL
        AND (
          -- phoneNumberId present but not owned
          (conv.metadata->>'phoneNumberId' IS NOT NULL
           AND conv.metadata->>'phoneNumberId' NOT IN (${
             owned.size === 0 ? `''` : Array.from(owned).map((_, i) => `$${i + 2}`).join(',')
           }))
          OR
          -- orphan-ish signals
          conv.participant_phone_number = ''
          OR conv.phone_number = ''
        )
      ORDER BY cc.created_at DESC
      LIMIT ${limit}`,
    [wsId, ...(owned.size === 0 ? [] : Array.from(owned))],
  );

  const foreign = [];
  const legitimate = [];
  const missing = [];
  const unknown = [];

  for (const row of suspect) {
    const verdict = await verifyCall(apiKey, row.provider_call_id);
    if (verdict === 'foreign') foreign.push(row);
    else if (verdict === 'owned') legitimate.push(row);
    else if (verdict === 'missing') missing.push(row);
    else unknown.push({ ...row, verdict });
    // gentle pacing — OpenPhone allows ~10 req/s
    await new Promise((r) => setTimeout(r, 120));
  }

  return {
    ownedPhoneCount: owned.size,
    suspectExamined: suspect.length,
    foreign,
    legitimate,
    missing,
    unknown,
  };
}

// ---------------------------------------------------------------------------
// Apply — delete verified-foreign call rows + prune emptied conversations.
// ---------------------------------------------------------------------------
async function applyDeletes(c, foreignIds) {
  if (foreignIds.length === 0) return { deleted: 0, prunedConvs: 0 };
  await c.query('BEGIN');
  try {
    // Delete calls first
    const del = await c.query(
      `DELETE FROM communication_calls WHERE id = ANY($1::uuid[]) RETURNING conversation_id`,
      [foreignIds],
    );
    const affectedConvs = Array.from(new Set(del.rows.map((r) => r.conversation_id)));

    // Prune conversations that are now empty of both calls AND messages
    const pruned = await c.query(
      `DELETE FROM communication_conversations
        WHERE id = ANY($1::uuid[])
          AND NOT EXISTS (SELECT 1 FROM communication_calls WHERE conversation_id = communication_conversations.id)
          AND NOT EXISTS (SELECT 1 FROM communication_messages WHERE conversation_id = communication_conversations.id)
        RETURNING id`,
      [affectedConvs],
    );
    await c.query('COMMIT');
    return { deleted: del.rowCount, prunedConvs: pruned.rowCount };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv);
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(2); }
  if (!process.env.ENCRYPTION_KEY) { console.error('ENCRYPTION_KEY missing'); process.exit(2); }

  const c = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
  });
  await c.connect();
  const summary = { commit: args.commit, workspaces: [] };
  try {
    // Layer 2
    const dupWebhookIds = await checkWebhookIdUniqueness(c);
    summary.webhookIdCollisions = dupWebhookIds;

    // Workspaces to scan
    const workspaces = args.workspaceId
      ? [{ id: args.workspaceId }]
      : await q(
          c,
          `SELECT DISTINCT w.id
             FROM workspaces w
             JOIN communication_integrations i ON i.workspace_id = w.id
            WHERE i.provider = 'openphone'
            ORDER BY w.id`,
          [],
        );

    for (const w of workspaces) {
      const res = await scanWorkspace(c, w.id, process.env.ENCRYPTION_KEY, args.limit);
      const entry = { workspaceId: w.id, ...res };

      if (!res.skipped && args.commit && res.foreign.length > 0) {
        const ids = res.foreign.map((r) => r.id);
        const applied = await applyDeletes(c, ids);
        entry.applied = applied;
      }
      summary.workspaces.push(entry);
    }

    if (args.json) {
      // Trim heavy arrays for JSON summary
      const trim = (arr) => arr.slice(0, 20);
      const compact = {
        ...summary,
        workspaces: summary.workspaces.map((w) => ({
          ...w,
          foreign: w.foreign ? trim(w.foreign) : undefined,
          foreignCount: w.foreign ? w.foreign.length : undefined,
          legitimateCount: w.legitimate ? w.legitimate.length : undefined,
          missingCount: w.missing ? w.missing.length : undefined,
          unknownCount: w.unknown ? w.unknown.length : undefined,
        })),
      };
      console.log(JSON.stringify(compact, null, 2));
    } else {
      printReport(summary);
    }

    process.exit(args.commit ? 1 : 0);
  } catch (e) {
    console.error('FATAL', e);
    process.exit(2);
  } finally {
    await c.end();
  }
}

function printReport(summary) {
  console.log('='.repeat(70));
  console.log('Issue #50 — OpenPhone cross-workspace inventory');
  console.log('Mode:', summary.commit ? 'COMMIT (deletes applied)' : 'DRY-RUN');
  console.log('='.repeat(70));

  // Layer 2
  console.log('\n[Layer 2] workspaces.webhook_id uniqueness:');
  if (summary.webhookIdCollisions.length === 0) {
    console.log('  OK — every webhook_id resolves to exactly one workspace.');
  } else {
    console.log(`  COLLISIONS FOUND (${summary.webhookIdCollisions.length}):`);
    for (const row of summary.webhookIdCollisions) {
      console.log(`    webhook_id=${row.webhook_id} → ${row.n} workspaces: ${row.workspace_ids.join(', ')}`);
    }
  }

  // Per workspace
  console.log('\n[Layer 3] Per-workspace scan:');
  for (const w of summary.workspaces) {
    console.log(`\n  workspace ${w.workspaceId}:`);
    if (w.skipped) {
      console.log(`    SKIPPED — ${w.reason}`);
      continue;
    }
    console.log(`    owned phone numbers        : ${w.ownedPhoneCount}`);
    console.log(`    suspect calls examined     : ${w.suspectExamined}`);
    console.log(`    verified foreign (403)     : ${w.foreign.length}`);
    console.log(`    verified legitimate (200)  : ${w.legitimate.length}`);
    console.log(`    upstream missing (404)     : ${w.missing.length}`);
    console.log(`    unknown status             : ${w.unknown.length}`);
    if (w.foreign.length > 0) {
      console.log('    first 10 foreign rows:');
      for (const r of w.foreign.slice(0, 10)) {
        console.log(`      call.id=${r.id} providerCallId=${r.provider_call_id} conv=${r.conversation_id} phoneNumberId=${r.phone_number_id}`);
      }
    }
    if (w.applied) {
      console.log(`    APPLIED: deleted ${w.applied.deleted} call rows, pruned ${w.applied.prunedConvs} empty conversations.`);
    }
  }

  if (!summary.commit) {
    console.log('\nRe-run with --commit to apply deletes.');
  }
}

main();
