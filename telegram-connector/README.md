# Sigcore Telegram Connector

Standalone microservice that bridges Telegram (Bot API + future MTProto/GramJS) into Sigcore's provider-agnostic communication model. Lives next to `whatsapp-service/`; identical deployment pattern.

```
Telegram
  → telegram-connector             (this service)
  → durable inbound event store     (telegram_inbound_events, on disk)
  → drainer / queue worker          (retry + dead-letter)
  → Sigcore ingestion API           (/webhooks/telegram/inbound)
  → Sigcore conversations / messages / identities / events
  → TelePorter / LeadBridge / ServiceFlow / AI workflows
```

The connector owns Telegram transport, auth/session lifecycle, webhook intake, normalization, and provider delivery state. **It does not own conversations, messages, identities, or routing** — those live in Sigcore core. The webhook handler enqueues a durable event and returns 200; the drainer is the only path that talks to Sigcore for messages.

## Endpoints

All routes are prefixed `/api`.

| Method | Path                                                  | Auth                                  | Purpose |
|--------|-------------------------------------------------------|---------------------------------------|---------|
| GET    | `/api/health`                                         | none                                  | Liveness + event-store status counts |
| POST   | `/api/telegram/accounts/connect`                      | `x-api-key`                           | Register a bot or MTProto account |
| GET    | `/api/telegram/accounts/status?tenantId=&accountId=`  | `x-api-key`                           | Fetch one account's status (secrets stripped) |
| GET    | `/api/telegram/accounts?tenantId=`                    | `x-api-key`                           | List a tenant's accounts |
| POST   | `/api/telegram/accounts/:accountId/disconnect`        | `x-api-key`                           | Mark disconnected + emit provider event |
| POST   | `/api/telegram/messages/send`                         | `x-api-key`                           | Send outbound message (idempotent) |
| GET    | `/api/telegram/events/dead?tenantId=`                 | `x-api-key`                           | List dead-lettered events for an operator |
| POST   | `/api/telegram/webhook/:tenantId/:accountId`          | `x-telegram-bot-api-secret-token`     | Telegram → connector (rate-limited) |

## Provider model

Participant key format:

```
telegram:<tenantId>:<accountId>:<telegramChatId>
```

Provider metadata on participant identities:

```ts
{
  provider: 'telegram',
  telegramChatId, telegramUserId,
  username, firstName, lastName, displayName, phone,
  chatType: 'private' | 'group' | 'supergroup' | 'channel',
  accountId, tenantId,
}
```

## Account modes

- **bot** — Telegram Bot API (`@TelePorterApp_bot`, lead-intake bots). MVP path, fully implemented.
- **mtproto** — GramJS user session. Account model + encrypted storage is wired. Outbound is rejected with `mtproto_outbound_not_implemented` until `TELEGRAM_MTPROTO_ENABLED=true` is set and Phase 4 ships the live login + transport.

Transport abstraction in `src/transports/`:

```ts
TelegramTransport {
  sendMessage(input): Promise<TelegramTransportSendResult>
  getAccountStatus(input): Promise<TelegramTransportStatus>
}
```

## Secrets

All credentials are encrypted at rest with **AES-256-GCM** using `TELEGRAM_ENCRYPTION_KEY` (32 random bytes, base64). Bot tokens and GramJS sessions are never logged — see `redact.ts` for the redactor applied across logging paths. The service refuses to register an account when the key is missing.

## Durable inbound event store

`data/telegram-events/<status>/<id>.json` — one file per event, status mirrored in the path so `ls` shows operator health at a glance.

Status machine: `pending → processing → sent` (success) | `pending → processing → pending` (transient failure, exponential back-off) | `pending → processing → dead` (max attempts exceeded).

Primary idempotency key:

```
tenantId + accountId + provider + externalMessageId
```

Fallback when Telegram doesn't surface a stable id:

```
telegramChatId + messageId + timestamp
```

Drainer tuning via env: `TELEGRAM_DRAINER_INTERVAL_MS` (2000), `TELEGRAM_DRAINER_BATCH_SIZE` (25), `TELEGRAM_DRAINER_MAX_ATTEMPTS` (8). On crash recovery, any `processing` entries are reset to `pending`.

## Provider events

The drainer + service emit lifecycle events to Sigcore on a separate channel (`/webhooks/telegram/provider-events`) so downstream products can subscribe without parsing the message firehose:

```
provider.account.connected
provider.account.disconnected
message.received      (drainer success)
message.sent          (outbound success)
message.failed        (terminal dead-letter OR outbound failure)
conversation.updated  (drainer success, last-message bump)
```

## Tests

```
npm install
npm test
```

Coverage:

- normalization of text + caption + supergroup + unsupported attachments
- durable inbound store: enqueue, dedupe, claim, sent, failed→retry, dead-letter, back-off, restart-safety, tenant-scoped listDead
- drainer: success path, retry, dead-letter, concurrent-tick safety, event-bus emission
- event bus: not-configured noop, post shape, network failure absorbed
- outbound: tenant isolation, idempotency, mtproto rejection, expired-account rejection, message.sent emission
- encryption: round-trip, random IV, missing/bad key rejection
- redaction: bot tokens, MTProto session, secret fields, phone codes, auth passwords

## Rollout

This branch covers:

- **Phase 1** — infra: connector skeleton, health, account model, internal auth
- **Phase 2** — Bot API MVP: webhook intake → durable store → drainer → Sigcore ingest, outbound send, idempotency, message.sent/message.failed events
- **Phase 4 scaffolding** — encrypted MTProto session storage, transport abstraction, feature flag (`TELEGRAM_MTPROTO_ENABLED`)

Phases 3 (TelePorter bridge behind `TELEPORTER_SIGCORE_TELEGRAM_ENABLED`) and 5 (LeadBridge lead pipeline) live in their respective product repos and consume this connector's APIs and provider events.
