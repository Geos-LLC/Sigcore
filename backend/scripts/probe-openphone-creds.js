#!/usr/bin/env node
/**
 * TASKS_2026-09-08_CONVERSATION_SYNC.md — Task 8 "Definitive finding" probe.
 *
 * For a given tenantId + workspaceId, print BOTH the tenant-scoped
 * (`tenant_integrations`) and workspace-scoped (`communication_integrations`)
 * OpenPhone rows, their statuses, and the SHA-256 fingerprint (first 8 hex)
 * of the DECRYPTED apiKey. Enables ops to verify:
 *
 *   (a) Which row `resolveIntegrationForCaller` would actually pick (ACTIVE
 *       tenant row wins; falls back to workspace row otherwise).
 *   (b) Whether the DECRYPTED credential matches the caller's expected key
 *       fingerprint (e.g. LB's stored ABC key sha256[0:8] = c79c061c).
 *
 * If the tenant row shows status != 'active', that's the silent-failure
 * pathology described in the 2026-09-10 "Definitive finding" note — Task 5's
 * status endpoint reports the tenant row (it doesn't filter by status), but
 * the sync resolver's ACTIVE-only filter drops back to the workspace row
 * (which on shared workspaces holds a foreign tenant's key).
 *
 * Usage:
 *   DATABASE_URL=... ENCRYPTION_KEY=... \
 *     node backend/scripts/probe-openphone-creds.js \
 *       --workspace <uuid> --tenant <uuid>
 *
 * Never prints the actual apiKey — only the SHA-256[:8] fingerprint.
 */

const { Client } = require('pg');
const CryptoJS = require('crypto-js');
const { createHash } = require('crypto');

function parseArgs(argv) {
  const out = { workspaceId: null, tenantId: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--workspace' || a === '--workspaceId') out.workspaceId = argv[++i];
    else if (a === '--tenant' || a === '--tenantId') out.tenantId = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: DATABASE_URL=... ENCRYPTION_KEY=... node probe-openphone-creds.js --workspace <uuid> --tenant <uuid>');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function fingerprint(plaintext) {
  if (!plaintext) return '(empty)';
  return createHash('sha256').update(plaintext).digest('hex').slice(0, 8);
}

function decryptSafely(ciphertext, key) {
  try {
    const bytes = CryptoJS.AES.decrypt(ciphertext, key);
    const plain = bytes.toString(CryptoJS.enc.Utf8);
    if (!plain) return { ok: false, error: 'empty plaintext (wrong key?)' };
    return { ok: true, plain };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function extractApiKey(plain) {
  try {
    const parsed = JSON.parse(plain);
    return parsed.apiKey || null;
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.workspaceId || !args.tenantId) {
    console.error('Both --workspace and --tenant are required');
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(2);
  }
  if (!process.env.ENCRYPTION_KEY) {
    console.error('ENCRYPTION_KEY not set — cannot decrypt credentials');
    process.exit(2);
  }
  const encKey = process.env.ENCRYPTION_KEY;

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('supabase.') || process.env.DATABASE_URL.includes('railway.')
      ? { rejectUnauthorized: false }
      : false,
  });
  await client.connect();

  console.log(`\n=== OpenPhone credential probe ===`);
  console.log(`workspace_id : ${args.workspaceId}`);
  console.log(`tenant_id    : ${args.tenantId}\n`);

  // Tenant-scoped row (any status)
  const tRows = await client.query(
    `SELECT id, status, credentials_encrypted, created_at, updated_at
       FROM tenant_integrations
      WHERE workspace_id = $1 AND tenant_id = $2 AND provider = 'openphone'`,
    [args.workspaceId, args.tenantId],
  );

  console.log(`--- tenant_integrations (scope=tenant) ---`);
  if (tRows.rows.length === 0) {
    console.log('(no rows)');
  } else {
    for (const r of tRows.rows) {
      const dec = decryptSafely(r.credentials_encrypted, encKey);
      const fp = dec.ok ? fingerprint(extractApiKey(dec.plain) || dec.plain) : '(decrypt failed)';
      console.log(
        `id=${r.id.slice(0, 8)}… status=${r.status.padEnd(8)} created=${r.created_at.toISOString()} apiKey_sha256[0:8]=${fp}${dec.ok ? '' : ` err=${dec.error}`}`,
      );
    }
  }

  // Workspace-scoped row (any status)
  const wRows = await client.query(
    `SELECT id, status, credentials_encrypted, created_at, updated_at
       FROM communication_integrations
      WHERE workspace_id = $1 AND provider = 'openphone'`,
    [args.workspaceId],
  );

  console.log(`\n--- communication_integrations (scope=workspace) ---`);
  if (wRows.rows.length === 0) {
    console.log('(no rows)');
  } else {
    for (const r of wRows.rows) {
      const dec = decryptSafely(r.credentials_encrypted, encKey);
      const fp = dec.ok ? fingerprint(extractApiKey(dec.plain) || dec.plain) : '(decrypt failed)';
      console.log(
        `id=${r.id.slice(0, 8)}… status=${r.status.padEnd(8)} created=${r.created_at.toISOString()} apiKey_sha256[0:8]=${fp}${dec.ok ? '' : ` err=${dec.error}`}`,
      );
    }
  }

  console.log(`\n--- resolver simulation ---`);
  const activeTenant = tRows.rows.find((r) => r.status === 'active');
  if (activeTenant) {
    console.log(
      `resolveIntegrationForCaller → tenant_integrations.${activeTenant.id.slice(0, 8)}… (ACTIVE)`,
    );
  } else if (tRows.rows.length > 0) {
    console.log(
      `resolveIntegrationForCaller → FALLBACK to workspace (tenant row exists but status != 'active')`,
    );
    console.log(
      `  ⚠ This is the silent-failure pathology. Task 5's /integrations/openphone endpoint reports the tenant row (it doesn't filter by status) but the sync uses the workspace row.`,
    );
    console.log(
      `  Fix: UPDATE tenant_integrations SET status='active' WHERE id='${tRows.rows[0].id}' AFTER verifying the row's apiKey fingerprint above matches the caller's expected key.`,
    );
  } else {
    console.log(
      `resolveIntegrationForCaller → workspace-scoped (no tenant row exists)`,
    );
  }

  await client.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
