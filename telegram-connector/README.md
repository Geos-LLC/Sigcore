# Sigcore Telegram Connector

Standalone microservice that bridges Telegram (Bot API + MTProto/GramJS) into Sigcore's provider-agnostic communication model. Lives next to `whatsapp-service/`; identical deployment pattern.

```
Telegram
  -> telegram-connector  (this service)
  -> Sigcore conversation/message APIs
  -> TelePorter / LeadBridge / ServiceFlow / AI workflows
```

Telegram-specific logic (MTProto sessions, bot token handling) is isolated here — Sigcore core never imports GramJS.

## Endpoints

All routes are prefixed `/api`.

| Method | Path                                                  | Auth                                  | Purpose |
|--------|-------------------------------------------------------|---------------------------------------|---------|
| GET    | `/api/health`                                         | none                                  | Liveness |
| POST   | `/api/telegram/accounts/connect`                      | `x-api-key`                           | Register a bot or MTProto account |
| GET    | `/api/telegram/accounts/status?tenantId=&accountId=`  | `x-api-key`                           | Fetch one account's status (secrets stripped) |
| GET    | `/api/telegram/accounts?tenantId=`                    | `x-api-key`                           | List a tenant's accounts |
| POST   | `/api/telegram/messages/send`                         | `x-api-key`                           | Send outbound message |
| POST   | `/api/telegram/webhook/:tenantId/:accountId`          | `x-telegram-bot-api-secret-token`     | Telegram → connector (rate-limited) |

## Provider model

Participant key format:

```
telegram:<tenantId>:<accountId>:<telegramChatId>
```

## Account modes

- **bot** — Telegram Bot API (`@TelePorterApp_bot`, lead-intake bots). MVP path.
- **mtproto** — GramJS user session. Account model + encrypted storage is wired; live MTProto login and outbound send are deferred to Phase 4 (`mtproto_outbound_not_implemented` is returned until then).

## Secrets

All credentials are encrypted at rest with AES-256-GCM using `TELEGRAM_ENCRYPTION_KEY` (32 random bytes, base64). Bot tokens and GramJS sessions are never logged — see `redact.ts` for the redactor applied across logging paths. The service refuses to register an account when the key is missing.

## Dedupe

`tenantId + accountId + telegramChatId:message_id` is the primary key. Fallback `chatId+messageId+timestamp` is available for flows where Telegram doesn't surface a stable id. In-memory LRU; if the connector restarts during a webhook storm Sigcore's own idempotency layer is the next line of defense.

## Tests

```
npm install
npm test
```

Coverage:

- inbound text + caption normalization
- dedupe on retry
- unsupported attachment safety (sticker)
- tenant isolation on read + outbound
- expired-account rejection
- MTProto outbound blocked
- idempotency-key deduping for sends
- Sigcore ingest failure surfaces `forwarded=false` for retry
- secret redaction
- encryption round-trip + bad-key rejection

## Rollout

Implemented here: **Phase 1** (infra) + **Phase 2** (Bot API MVP) + the account/storage scaffolding for **Phase 4** (MTProto). Phases 3 (TelePorter bridge behind `TELEPORTER_SIGCORE_TELEGRAM_ENABLED`) and 5 (LeadBridge lead pipeline) live in their respective product repos and consume this connector's APIs.