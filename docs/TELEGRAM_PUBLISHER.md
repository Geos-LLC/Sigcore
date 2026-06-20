# Telegram Publisher

Sigcore wrapper over TelePorter that lets tenants publish ads to Telegram channels.
Same architectural shape as the WhatsApp service: a standalone microservice owns
TelePorter creds + the inbound HMAC verify; main Sigcore owns the tenant-facing
API + the placement table + outbound webhook fan-out.

```
HF (tenant) → Sigcore /integrations/telegram/* → telegram-service μsvc → TelePorter HTTP API
                       (x-api-key tenant)         (x-api-key SERVICE_API_KEY)   (X-TelePorter-Service-Key)

TelePorter → telegram-service /webhooks/teleporter → Sigcore /internal/telegram/event
            (X-TelePorter-Signature HMAC)            (x-webhook-key SIGCORE_WEBHOOK_KEY)
```

## Components

| Component | Owner | Purpose |
|---|---|---|
| `telegram-service/` (this repo, sibling to `whatsapp-service/`) | us | TelePorter HTTP wrapper, verify cache, callback HMAC verify |
| `backend/src/modules/integrations/telegram/` | us | Tenant API (subscribe, verify, publish, cancel), DB-backed idempotency, webhook fan-out |
| TelePorter | other agent | The actual Telegram Bot API integration + bot provisioning |

## Deploy — telegram-service Railway

1. **Create service**: `telegram-publisher-production`. Root dir: `telegram-service/`. Docker build (Node 20-slim, no Chromium needed).
2. **Healthcheck path**: `/health` (returns `{status:'ok',service:'sigcore-telegram'}`).
3. **Env vars** (set in Railway service settings):
   - `PORT=3002`
   - `SERVICE_API_KEY` — generate a 32-byte hex; must match `TELEGRAM_SERVICE_API_KEY` on the main Sigcore service.
   - `SIGCORE_API_URL` — `https://sigcore-production.up.railway.app`
   - `SIGCORE_WEBHOOK_KEY` — must match the same env on main Sigcore (shared with WhatsApp µsvc).
   - `TELEPORTER_BASE_URL` — coordinate with the TelePorter agent (e.g. `https://teleporter.one/api/v1`).
   - `TELEPORTER_SERVICE_KEY` — shared secret with TelePorter; double-duty as auth header outbound and HMAC verify key inbound.
   - `TELEPORTER_CALLBACK_URL` — `https://telegram-publisher-production.up.railway.app/webhooks/teleporter` (the public URL TelePorter will hit when a message is sent or fails).
   - `TELEGRAM_VERIFY_CACHE_TTL_MS=3600000` (1h; tune down if `bot_removed_from_chat`-style staleness becomes a problem)
   - `TELEGRAM_VERIFY_CACHE_MAX_ENTRIES=5000`

## Deploy — main Sigcore additions

Already covered by the existing `sigcore-production` Railway service. Add these env vars there too:

- `TELEGRAM_SERVICE_URL` — `https://telegram-publisher-production.up.railway.app`
- `TELEGRAM_SERVICE_API_KEY` — must match `SERVICE_API_KEY` on the µsvc.
- `SIGCORE_WEBHOOK_KEY` — already set (shared with WhatsApp µsvc). Reuse.

Migration `1766000000000-TelegramPublisher` runs automatically on the next deploy (Sigcore's `migrationsRun: true` in prod). Creates `telegram_subscribers` and `telegram_placements`.

## Local development

```bash
# Terminal 1: TelePorter stub
cd telegram-service
TELEPORTER_SERVICE_KEY=stub-secret npm run stub:teleporter

# Terminal 2: telegram-service
cd telegram-service
SERVICE_API_KEY=svc-test-key \
SIGCORE_API_URL=http://localhost:3001 \
SIGCORE_WEBHOOK_KEY=wh-test-key \
TELEPORTER_BASE_URL=http://localhost:4000 \
TELEPORTER_SERVICE_KEY=stub-secret \
TELEPORTER_CALLBACK_URL=http://localhost:3002/webhooks/teleporter \
npm run start:dev

# Terminal 3: main Sigcore backend
cd backend
TELEGRAM_SERVICE_URL=http://localhost:3002 \
TELEGRAM_SERVICE_API_KEY=svc-test-key \
SIGCORE_WEBHOOK_KEY=wh-test-key \
npm run start:dev
```

## Tenant API (HF-facing)

Auth: standard Sigcore tenant API key (`sc_tenant_*`) via `x-api-key` header.

### `POST /api/integrations/telegram/subscribe`
Provisions a workspace bot via TelePorter (idempotent — second call returns the existing subscriber).

Request: `{ displayName?: string }`

Response: `{ botUsername, status: 'provisioning' | 'ready' | 'retired', inviteHint? }`

### `GET /api/integrations/telegram/status`
Returns `{ botUsername?, status, inviteHint? }`. `status='not_initialized'` if no subscriber row exists.

### `POST /api/integrations/telegram/verify-chat`
Request: `{ chatRef: '@cleaners_jax', probe?: boolean }`

Response: TelePorter's full verdict object. Always includes `warnings: ['PAY_TO_POST_NOT_DETECTABLE', ...]` when verdict status is `ready` (channel pay-to-post restrictions can't be detected via the Bot API).

`probe: true` bypasses the verify cache (1h default TTL) — use sparingly, it's rate-limit expensive on TelePorter's side.

### `POST /api/integrations/telegram/publish`
Request:
```json
{
  "chatRef": "@cleaners_jax",
  "text": "Now hiring cleaners — $20/hr, flexible hours",
  "parseMode": "Markdown",
  "imageUrl": "https://example.com/ad.png",
  "scheduledAt": "2026-06-20T10:00:00Z",
  "externalRef": "hf-placement-uuid"
}
```

Response: `{ placementId, status: 'queued' | 'scheduled', scheduledAt? }`

**Idempotency:** `(workspace_id, external_ref)` is unique. The same `externalRef` will always return the same `placementId` without re-publishing to TelePorter.

### `POST /api/integrations/telegram/placements/:id/cancel`
Cancels a queued or scheduled placement. 409 if already sent or failed.

### `GET /api/integrations/telegram/placements/:id`
Returns the full placement row.

## Outbound webhook events

`telegram.placement.sent` and `telegram.placement.failed` are now registered in the
`WebhookEventType` enum. HF (or any other tenant) subscribes via the existing
webhook subscriptions API:

```bash
curl -X POST "https://sigcore-production.up.railway.app/api/webhooks/subscriptions" \
  -H "X-API-Key: sc_tenant_HF_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "HF placement events",
    "webhookUrl": "https://hirefunnel.app/api/webhooks/sigcore/telegram-placement",
    "secret": "hf-shared-webhook-secret",
    "events": ["telegram.placement.sent", "telegram.placement.failed"]
  }'
```

Event payload (`data` field):
```json
{
  "placementId": "...",
  "chatRef": "@cleaners_jax",
  "externalRef": "hf-placement-uuid",
  "teleporterMessageId": "msg_abc123",
  "providerMessageId": "tg_999",
  "status": "sent" | "failed",
  "errorCode": "CHAT_NOT_FOUND",
  "errorMessage": "...",
  "occurredAt": "2026-06-19T..."
}
```

Subscriptions follow the standard Sigcore outbound HMAC contract (`X-Callio-Timestamp` + `X-Callio-Signature`, see [outbound-webhooks.service.ts](../backend/src/modules/webhooks/outbound-webhooks.service.ts) for the signing shape).

## Shared-secret rotation

Two shared secrets are load-bearing:

1. **`SIGCORE_WEBHOOK_KEY`** (main Sigcore ↔ telegram-service callback)
2. **`TELEPORTER_SERVICE_KEY`** (telegram-service ↔ TelePorter, both directions)

Both must be rotated **simultaneously on both ends** within seconds of each other. The
safe order:

1. Generate new value.
2. Update the receiver first (main Sigcore for #1; TelePorter for #2's inbound direction).
3. Briefly the sender will fail auth — callbacks queue/retry on the sender side.
4. Update the sender.
5. Verify a fresh event flows end-to-end.

For `TELEPORTER_SERVICE_KEY` specifically: the key does double duty (outbound auth header AND HMAC verify key for inbound). Both halves must rotate atomically. Coordinate with the TelePorter agent.

## Verify-cache TTL knob

Default: `TELEGRAM_VERIFY_CACHE_TTL_MS=3600000` (1h). Lower it (e.g. `900000` for 15m) if you start seeing stale `ready` verdicts from chats where the bot was actually removed — TelePorter currently has no eviction signal we can hook into. We'll add one if/when the contract gains a `bot_removed_from_chat` event.

The cache is in-memory in the µsvc (per architectural decision: it sits closer to TelePorter, so the µsvc can short-circuit verify requests without round-tripping back to main Sigcore). Cache state is lost on µsvc redeploy — that's acceptable; the next request just re-fetches.

## Tests

- `cd backend && npx jest telegram` — 24 tests across service, controller, and callback specs.
- `cd telegram-service && npm test` — 29 tests across verify-cache, teleporter-client, telegram.service, telegram.controller, webhooks.controller.

## Out of scope (future work)

- Frontend: no admin UI for placements; HF consumes the API directly.
- Inbound message handling: publish-only.
- Multi-chat batch publish: one chat per `/publish` call.
- Stripe/entitlement: assumed handled before HF reaches Sigcore.
- Per-workspace probe rate-limit budget: not enforced yet.

## Contract gaps surfaced during build

(none yet — update this section as the TelePorter agent's contract evolves.)
