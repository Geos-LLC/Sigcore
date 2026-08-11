#!/usr/bin/env node
/**
 * Issue #50 live verification.
 *
 * Sends a synthetic OpenPhone `call.completed` webhook to Sigcore prod with
 * a made-up `phoneNumberId` (guaranteed foreign — the workspace's own
 * OpenPhone account cannot own an id we invented). Then queries Grafana
 * Loki for the `[openphone-webhook] REJECT` warn line carrying the same
 * externalId this script generated.
 *
 * Pass criteria (all three must hold):
 *   - HTTP 200 from the webhook endpoint
 *   - `[openphone-webhook] REJECT` log line appears in Loki with a matching
 *     externalId within N seconds
 *   - No `[Nest] error` in the same window for that externalId
 *
 * Usage:
 *   GRAFANA_SA_TOKEN=… node backend/scripts/test-openphone-foreign-reject-2026-08-10.js \
 *     --webhook-id <token> \
 *     [--base https://sigcore-production.up.railway.app] \
 *     [--wait 15]           # seconds to poll Loki
 *
 * The webhook-id comes from `workspaces.webhook_id` in the Sigcore DB.
 * Any workspace's token will do — we're not writing anything, we're
 * exercising the REJECT path.
 *
 * Exit codes:
 *   0 — pass
 *   1 — fail (see stderr)
 *   2 — invocation / env error
 */

const crypto = require('crypto');

function parseArgs(argv) {
  const out = {
    webhookId: null,
    base: 'https://sigcore-production.up.railway.app',
    wait: 15,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--webhook-id') out.webhookId = argv[++i];
    else if (a === '--base') out.base = argv[++i];
    else if (a === '--wait') out.wait = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node test-openphone-foreign-reject-2026-08-10.js --webhook-id <token> [--base URL] [--wait N]');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

const GRAFANA_URL = 'https://info3d7b.grafana.net';
const LOKI_PROXY_ID = '7';

async function queryLoki(token, expr, from, to) {
  const url = new URL(`${GRAFANA_URL}/api/datasources/proxy/${LOKI_PROXY_ID}/loki/api/v1/query_range`);
  url.searchParams.set('query', expr);
  url.searchParams.set('start', String(from * 1_000_000_000));
  url.searchParams.set('end', String(to * 1_000_000_000));
  url.searchParams.set('limit', '50');
  url.searchParams.set('direction', 'backward');
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Loki ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const streams = body?.data?.result ?? [];
  const lines = [];
  for (const s of streams) for (const [_, line] of s.values) lines.push(line);
  return lines;
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const args = parseArgs(process.argv);
  if (!args.webhookId) { console.error('--webhook-id required'); process.exit(2); }
  if (!process.env.GRAFANA_SA_TOKEN) { console.error('GRAFANA_SA_TOKEN missing'); process.exit(2); }

  const nonce = crypto.randomBytes(8).toString('hex');
  const externalId = `TEST-foreign-${nonce}`;
  const fakePhoneNumberId = `PNfake${nonce.slice(0, 10)}`;

  const url = `${args.base}/api/webhooks/openphone/${encodeURIComponent(args.webhookId)}`;
  const payload = {
    id: `EV-${nonce}`,
    type: 'call.completed',
    data: {
      object: {
        id: externalId,
        object: 'call',
        direction: 'incoming',
        phoneNumberId: fakePhoneNumberId,
        userId: 'USfaketest',
        from: '+15550000000',
        to: ['+18885550000'],
        status: 'completed',
        duration: 1,
        createdAt: new Date().toISOString(),
      },
    },
  };

  console.log(`[test] POST ${url}`);
  console.log(`[test]   synthetic externalId=${externalId} phoneNumberId=${fakePhoneNumberId}`);
  const postStart = Math.floor(Date.now() / 1000) - 5;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const respBody = await res.text();
  console.log(`[test] HTTP ${res.status} — body: ${respBody.slice(0, 200)}`);
  if (res.status !== 200) {
    console.error('[test] FAIL — webhook endpoint did not return 200');
    process.exit(1);
  }

  // Wake Grafana (info3d7b sleeps after inactivity)
  await fetch(`${GRAFANA_URL}/api/org`, {
    headers: { Authorization: `Bearer ${process.env.GRAFANA_SA_TOKEN}` },
  }).catch(() => {});

  // Poll Loki
  console.log(`[test] polling Loki for up to ${args.wait}s…`);
  const rejectExpr = `{service_name="sigcore-api"} |= "openphone-webhook" |= "REJECT" |= "${externalId}"`;
  const errorExpr  = `{service_name="sigcore-api"} |= "${externalId}" | json | level="error"`;

  let rejectHit = null;
  const deadline = Date.now() + args.wait * 1000;
  while (Date.now() < deadline) {
    await sleep(2000);
    const now = Math.floor(Date.now() / 1000);
    const lines = await queryLoki(process.env.GRAFANA_SA_TOKEN, rejectExpr, postStart, now);
    if (lines.length > 0) { rejectHit = lines[0]; break; }
  }

  // Also scan for errors in the same window
  const nowFinal = Math.floor(Date.now() / 1000);
  const errorLines = await queryLoki(process.env.GRAFANA_SA_TOKEN, errorExpr, postStart, nowFinal);

  console.log('');
  console.log('[test] === RESULT ===');
  if (rejectHit) {
    console.log('[test] PASS — REJECT log line observed:');
    console.log('        ' + rejectHit);
  } else {
    console.log('[test] FAIL — no REJECT log line for externalId within window');
  }
  if (errorLines.length > 0) {
    console.log(`[test] WARN — ${errorLines.length} error log line(s) mentioning externalId:`);
    for (const l of errorLines.slice(0, 5)) console.log('        ' + l);
  }

  if (rejectHit && errorLines.length === 0) process.exit(0);
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(2); });
