# SIGCORE — OpenPhone Contact Cache + Participant Correlation (Clean Architecture)

Status: Draft → Ready for implementation
Owner: platform
Related: `../SIGCORE_OPENPHONE_CORRELATION.md` (repo-root sister plan, participant layer description — this plan supersedes and implements)

---

## 1. Goal

Fix OpenPhone identity gaps and live-pagination performance by introducing **two Sigcore-owned layers** — a provider-contact cache and a communication-participant identity layer — while preserving architectural boundaries:

- **Sigcore** owns provider truth + communication identity.
- **ServiceFlow** owns CRM identity + business meaning.

Sigcore does NOT become a tenant-writable CRM store. All tenant enrichment stays in the tenant's own system and is overlaid on read.

---

## 2. Problem

Current behavior:

- **OpenPhone:** conversations auto-create per phone; contacts are optional/user-created; no FK between conversation and contact.
- **Sigcore:** mirrors that separation — returns conversations and contacts independently.
- **ServiceFlow:** receives disconnected data — ~60% of conversations can't map to a contact (measured against SF tenant: 3,413 conversations, 1,355 with `company: null`, of which 1,178 have no OpenPhone contact record at all).

### Root cause

- No stable identity layer between conversation and contact.
- OpenPhone's provider model leaks directly into SF.

Already-shipped heuristics in [backend/src/modules/integrations/integrations.service.ts:553-760](backend/src/modules/integrations/integrations.service.ts#L553-L760) (`getAllOpenPhoneConversations`) — sibling-name match, full-value match, ≥2-contact token match in `inferCompany` — help at the margins but can't close the 1,178-gap where OpenPhone has no contact at all.

---

## 3. Solution Overview

Introduce **two layers** inside Sigcore.

### Layer 1 — Provider Contact Cache
- Cache OpenPhone `/contacts` locally in `openphone_contact_snapshot`.
- Remove live pagination from the conversations read path.
- Provide consistent provider data for downstream consumers.

### Layer 2 — Communication Participant (identity layer)
- Normalize phone → participant in `communication_participants`.
- Link conversations to participants; link participants to provider contacts when a snapshot exists.
- Expose a stable identity object (`participantId`, `participantKey`) for SF to join against.

### Constraint — what Sigcore does NOT do

- No tenant-writable CRM fields.
- No company/lead/customer ownership from SF.
- No enrichment writes from tenants.
- No provider mutation (no creating Quo contacts from Sigcore).

---

## 4. Data Model

### 4.1 Table: `openphone_contact_snapshot`

Purpose: cache OpenPhone provider data only.

Migration: `backend/src/database/migrations/1752000000000-OpenPhoneContactSnapshot.ts`.

```sql
CREATE TABLE openphone_contact_snapshot (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL,
  tenant_id             uuid NOT NULL,
  provider_account_id   varchar,
  phone_e164            varchar(32) NOT NULL,
  phone_last10          varchar(10) NOT NULL,
  provider_contact_id   varchar,
  provider_first_name   varchar(200),
  provider_last_name    varchar(200),
  provider_company      varchar(300),
  provider_updated_at   timestamptz,
  metadata              jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT UQ_opcs_tenant_phone UNIQUE (workspace_id, tenant_id, phone_e164)
);

CREATE INDEX IDX_opcs_tenant_last10     ON openphone_contact_snapshot (workspace_id, tenant_id, phone_last10);
CREATE INDEX IDX_opcs_tenant_contact_id ON openphone_contact_snapshot (workspace_id, tenant_id, provider_contact_id) WHERE provider_contact_id IS NOT NULL;
CREATE INDEX IDX_opcs_provider_updated  ON openphone_contact_snapshot (provider_updated_at);
```

Notes:
- Column names prefixed `provider_*` make it unmistakable that this is provider-owned data, not tenant-owned.
- `metadata` holds raw `defaultFields` + `customFields` for debug / future heuristics; not queried.
- Multi-contact dedup (OpenPhone allows duplicates sharing a phone — see today's `mergeContact` at [integrations.service.ts:605](backend/src/modules/integrations/integrations.service.ts#L605)) is applied at write time with first-non-null-wins semantics.

### 4.2 Table: `communication_participants`

Purpose: canonical **communication identity** — provider-agnostic by design (OpenPhone today; Twilio/WhatsApp/future providers later). A participant represents "a phone-number-based communication endpoint as Sigcore sees it", NOT "a person". Cross-provider merging of the same real person is an explicit non-goal of this plan (see §15).

Migration: `backend/src/database/migrations/1752000100000-CommunicationParticipants.ts`.

```sql
CREATE TABLE communication_participants (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id            uuid NOT NULL,
  tenant_id               uuid NOT NULL,
  provider                varchar NOT NULL,                 -- 'openphone' today
  provider_account_id     varchar NOT NULL DEFAULT '',      -- OpenPhone account/workspace id; '' when unknown (sentinel so it's index-safe)
  participant_key         text NOT NULL,                    -- 'openphone:<tenant_id>:<provider_account_id>:<phone_e164>'
  normalized_phone_e164   varchar(32) NOT NULL,
  raw_phone               varchar,
  provider_contact_id     varchar,                          -- FK-by-value to snapshot.provider_contact_id when linked
  provider_display_name   varchar,
  provider_company        varchar,
  first_seen_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at            timestamptz NOT NULL DEFAULT now(),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT UQ_cp_identity UNIQUE (workspace_id, tenant_id, provider, provider_account_id, normalized_phone_e164)
);

CREATE INDEX IDX_cp_participant_key     ON communication_participants (participant_key);
CREATE INDEX IDX_cp_provider_contact_id ON communication_participants (workspace_id, tenant_id, provider, provider_contact_id) WHERE provider_contact_id IS NOT NULL;
CREATE INDEX IDX_cp_phone_lookup        ON communication_participants (workspace_id, tenant_id, normalized_phone_e164);
```

### 4.2.1 Why `provider_account_id` in the uniqueness constraint

The naive key `(workspace_id, tenant_id, provider, phone_e164)` assumes **phone = person**. That breaks immediately when:

- The same phone number exists across two OpenPhone accounts the tenant has connected (distinct inboxes).
- The same phone is used on different provider lines (one Quo account sending SMS, another receiving WhatsApp — future).
- A customer texts multiple Quo lines belonging to the same tenant with different operational contexts.

Adding `provider_account_id` to the uniqueness constraint scopes the participant correctly to the provider account that saw this number. When OpenPhone's `provider_account_id` is unknown at sync time, we use the sentinel `''` (empty string) so the unique index still fires. Once we learn the account id (any subsequent sync that returns it), a migration-level update links the sentinel rows.

Sniffing `provider_account_id`: OpenPhone's `/phone-numbers` response carries account-level metadata; we capture it once per sync and store on both snapshot and participant.

### 4.3 Conversation FK to participant

Migration: `backend/src/database/migrations/1752000200000-ConversationParticipantFk.ts`.

Add to `communication_conversations`:

```sql
ALTER TABLE communication_conversations
  ADD COLUMN participant_id             uuid,
  ADD COLUMN participant_key            text,
  ADD COLUMN participant_phone_e164     varchar(32);

CREATE INDEX IDX_cc_participant_id  ON communication_conversations (participant_id);
CREATE INDEX IDX_cc_participant_key ON communication_conversations (participant_key);
```

No hard FK constraint (keeps sync latitude — participant row may be created in the same transaction but we don't want a failed participant write to block conversation writes). Referential integrity is maintained by the sync service.

---

## 5. Phone Normalization

Single canonical utility: `backend/src/common/util/phone.ts` (new).

```ts
export function normalizeToE164(raw: string): { e164: string | null; last10: string | null };
```

- Parses to E.164 using `libphonenumber-js` (needs dependency add — see Open Question 16.1).
- Returns `{ e164: '+18135551234', last10: '8135551234' }`.
- Returns `{ e164: null, last10: null }` if unparseable. Caller skips + logs + increments a counter.
- Replaces the US-only `normalizePhoneDigits` / `normalizeDigits` in [openphone.provider.ts:699](backend/src/modules/communication/providers/openphone.provider.ts#L699) and [integrations.service.ts:584](backend/src/modules/integrations/integrations.service.ts#L584) — those are left in place as thin wrappers delegating to the new util to avoid churn in unrelated call sites.

All writes to `openphone_contact_snapshot.phone_e164`, `communication_participants.normalized_phone_e164`, and `communication_conversations.participant_phone_e164` MUST go through this util.

---

## 6. Write Paths

### 6.1 Source A — OpenPhone `/contacts` sync (periodic / on-demand)

Endpoint: `POST /integrations/openphone/contacts/sync` (new) → 202 Accepted.

```
POST /integrations/openphone/contacts/sync
  → integrationsService.syncOpenPhoneContactsToCache(workspaceId, tenantId)
  → resolveCredentials(workspaceId, tenantId)
  → providerAccountId = sniffProviderAccountId(credentials)   // from /phone-numbers
  → openPhoneProvider.getOpenPhoneContacts(credentials)       // existing pagination
  → for each contact:
      for each phoneNumbers[].value:
        normalizeToE164 → skip if invalid
        BEGIN TRANSACTION
          upsertSnapshotAndCascade({
            workspace_id, tenant_id, provider_account_id,
            phone_e164, phone_last10,
            provider_contact_id: contact.id,
            provider_first_name, provider_last_name, provider_company,
            provider_updated_at: contact.updatedAt,
            metadata,
          })
        COMMIT
```

Where `upsertSnapshotAndCascade` runs BOTH the snapshot write AND the cascade update to any already-existing participant rows that share the phone — see §6.4.

Scheduling: on-demand only in this PR. Triggered by:
- Tenant explicit `POST .../sync`.
- Internally at the end of the existing `POST /integrations/sync` full sync.

### 6.2 Source B — OpenPhone webhooks

Extend [webhooks.service.ts:214](backend/src/modules/webhooks/webhooks.service.ts#L214) `handleOpenPhoneWebhook` to handle:
- `contact.created` / `contact.updated` → `upsertSnapshotAndCascade` (§6.4).
- `contact.deleted` → `deleteSnapshotAndCascade`: null out `provider_*` fields on the snapshot row AND null `provider_contact_id` / `provider_display_name` / `provider_company` on participants that referenced it. Participants stay (conversations still point at them) — they become "known phone, no known contact".

Subject to Open Question 16.2 (do these webhook events exist in OpenPhone's API?).

### 6.3 Source C — Conversation ingest

During conversation sync (existing paths in [communication.service.ts](backend/src/modules/communication/communication.service.ts) — `syncConversations`, `quickSyncConversations`, webhook inbound `message.*`):

```
for each conversation:
  participantPhone = conversation.participantPhoneNumber
  normalizeToE164 → skip conversation if invalid
  snapshot = snapshotRepo.findOne({ workspace_id, tenant_id, provider_account_id, phone_e164 })
  participant = upsertParticipant({
    workspace_id, tenant_id, provider_account_id,
    provider: 'openphone',
    phone_e164, raw_phone: participantPhone,
    // provider fields filled from snapshot when available, else null:
    provider_contact_id:   snapshot?.provider_contact_id   ?? existing.provider_contact_id   ?? null,
    provider_display_name: snapshot ? resolveDisplayName(snapshot) : existing.provider_display_name ?? null,
    provider_company:      snapshot?.provider_company      ?? existing.provider_company      ?? null,
    last_seen_at: now,
  })
  conversation.participant_id = participant.id
  conversation.participant_key = participant.participant_key
  conversation.participant_phone_e164 = phone_e164
```

`resolveDisplayName` is defined in §7.

Participant rows are created for every conversation whose participant phone parses to E.164 — including phones OpenPhone has no contact for. That participant row just lacks the provider fields until a snapshot appears (at which point §6.4's cascade fills them in).

### 6.4 The `upsertSnapshotAndCascade` routine

Every snapshot write (Sources A and B) runs in a transaction that also keeps participants in sync. This closes the race "conversation arrived first, snapshot appeared later, participant never learned about its contact":

```sql
BEGIN;

-- Step 1: upsert snapshot
INSERT INTO openphone_contact_snapshot (…)
VALUES (…)
ON CONFLICT (workspace_id, tenant_id, phone_e164)
  DO UPDATE SET
    provider_contact_id = EXCLUDED.provider_contact_id,
    provider_first_name = EXCLUDED.provider_first_name,
    provider_last_name  = EXCLUDED.provider_last_name,
    provider_company    = EXCLUDED.provider_company,
    provider_updated_at = EXCLUDED.provider_updated_at,
    metadata            = EXCLUDED.metadata,
    updated_at          = now()
  WHERE openphone_contact_snapshot.provider_updated_at IS NULL
     OR EXCLUDED.provider_updated_at >= openphone_contact_snapshot.provider_updated_at;

-- Step 2: cascade to every participant that shares this phone (any provider_account_id),
-- unconditional overwrite — snapshot is truth.
UPDATE communication_participants
SET provider_contact_id   = $new_contact_id,
    provider_display_name = $new_display_name,
    provider_company      = $new_company,
    updated_at            = now()
WHERE workspace_id = $ws
  AND tenant_id = $t
  AND provider  = 'openphone'
  AND normalized_phone_e164 = $phone_e164
  AND (
    -- only update if something actually changed, to avoid spurious updated_at bumps
    provider_contact_id   IS DISTINCT FROM $new_contact_id   OR
    provider_display_name IS DISTINCT FROM $new_display_name OR
    provider_company      IS DISTINCT FROM $new_company
  );

COMMIT;
```

For `contact.deleted`, the cascade runs with `$new_contact_id = NULL`, `$new_display_name = NULL`, `$new_company = NULL`.

Both writes are in one transaction so a partial failure leaves the system consistent (either both rows reflect the new Quo state, or neither does).

### Removed from scope

- ❌ `PATCH /integrations/openphone/contacts/bulk-enrich` (tenant push).
- ❌ `DELETE /integrations/openphone/contacts/:phone`.
- ❌ Precedence matrix (no multi-source conflict to resolve — all writes come from Quo).

---

## 7. Participant Derivation Logic

For any phone in a conversation:

```
participant_key = 'openphone:' + tenant_id + ':' + provider_account_id + ':' + phone_e164
```

(`provider_account_id` segment is `''` when unknown — matches the uniqueness sentinel from §4.2.)

### 7.1 Field population

| Field                   | Source                                                                           |
|-------------------------|----------------------------------------------------------------------------------|
| `normalized_phone_e164` | conversation participant phone, normalized                                       |
| `raw_phone`             | original unnormalized string                                                     |
| `provider_account_id`   | sniffed from OpenPhone `/phone-numbers` per sync; `''` sentinel if unknown       |
| `provider_contact_id`   | snapshot row matched by (workspace_id, tenant_id, phone_e164)                    |
| `provider_display_name` | `resolveDisplayName(snapshot)` — see §7.2                                        |
| `provider_company`      | snapshot `provider_company`                                                      |
| `last_seen_at`          | bumped on every conversation/message touch                                       |

When the snapshot for a phone is updated (Source A or B), participant rows referencing that phone are updated in the same transaction — see §6.4.

### 7.2 Deterministic `resolveDisplayName(snapshot)`

Partial snapshots (only firstName, only company, etc.) are common in real OpenPhone data. Define one deterministic function used by every write path:

```ts
function resolveDisplayName(s: { providerFirstName?: string|null; providerLastName?: string|null; providerCompany?: string|null }): string | null {
  const first = (s.providerFirstName || '').trim();
  const last  = (s.providerLastName  || '').trim();
  const fullName = [first, last].filter(Boolean).join(' ').trim();
  if (fullName) return fullName;              // "Jane Doe" | "Jane" | "Doe"
  const company = (s.providerCompany || '').trim();
  if (company) return company;                // "Acme Services"
  return null;                                 // caller falls back to phone at render time
}
```

The participant stores the already-resolved value in `provider_display_name`. Phone-as-fallback is a **render-time** concern (frontend / SF) — we never store a phone as the display name because that prevents us from later discovering "display name is now known" via a simple `IS NOT NULL` query.

---

## 8. API Changes

### 8.1 `GET /integrations/openphone/conversations/all` — updated response shape

Each conversation entry adds a top-level `participant` object. Provider-owned fields are nested under `provider` to leave room for future providers and future fields (email, avatar, role, etc.) without another breaking change:

```json
{
  "participantId": "…uuid…",
  "participantKey": "openphone:<tenant_id>:<provider_account_id>:+18135551234",
  "participantPhoneE164": "+18135551234",
  "provider": {
    "name": "openphone",
    "accountId": "…",
    "contactId": "op_ct_123",
    "displayName": "John Smith",
    "company": "Acme Services"
  }
}
```

Legacy fields retained for back-compat, deprecated in docs, to be removed once SF cuts over in PR4:
- `company`       → alias of `provider.company`
- `firstName`     → parsed from snapshot (kept raw, not derived from `provider.displayName`)
- `lastName`      → parsed from snapshot
- `providerContactId` / `providerDisplayName` / `providerCompany` — flat aliases of the nested `provider.*`

### 8.2 `GET /integrations/openphone/participants` — new

Query: `?phone=+18135551234` (optional) `?linked=true|false` (optional) `?limit=100&cursor=…`.

Response (matches the `provider`-nested shape of §8.1 for consistency):

```json
{
  "data": [
    {
      "id": "…uuid…",
      "participantKey": "openphone:<tenant_id>:<provider_account_id>:+18135551234",
      "phone": "+18135551234",
      "provider": {
        "name": "openphone",
        "accountId": "…",
        "contactId": "op_ct_123",
        "displayName": "John Smith",
        "company": "Acme Services"
      },
      "conversationCount": 3,
      "firstSeenAt": "…",
      "lastSeenAt": "…"
    }
  ],
  "nextCursor": null
}
```

### 8.3 `POST /integrations/openphone/contacts/sync` — new (internal admin)

Body: `{}`. Response: `202 Accepted`, `{ data: { started: true } }`. Runs Source A.

### 8.4 Removed endpoints

- ❌ `PATCH /integrations/openphone/contacts/bulk-enrich`
- ❌ `DELETE /integrations/openphone/contacts/:phone`
- ❌ Any tenant-write enrichment path.

### Auth

- All read endpoints honor existing scope (workspace key sees all tenants in workspace; tenant key sees only its own).
- Write endpoints (Source A sync trigger) accept either scope.

---

## 9. Read Path

### 9.1 Source of truth on read

**Always trust `communication_participants` for the response.** The cascade in §6.4 guarantees participants reflect the latest snapshot within a single write transaction, so participants are never stale relative to snapshots — freshness flows snapshot → participant. The read path never joins conversations directly to snapshots; it joins conversations → participants.

This is why the race condition identified in the review doesn't exist in this design: snapshot writes always update dependent participants atomically, so a "snapshot fresher than participant" state is impossible outside of a transaction rollback.

### 9.2 Replacing live pagination

Replace live `/contacts` pagination in `getAllOpenPhoneConversations` ([integrations.service.ts:581-633](backend/src/modules/integrations/integrations.service.ts#L581-L633)) with a single DB read:

```ts
// 1) One DB hit for participants in this tenant — already cascade-fresh.
const participants = await participantRepo.find({
  where: { workspaceId, tenantId, provider: 'openphone' },
});
const participantById = new Map(participants.map(p => [p.id, p]));

// 2) For each conversation, look up its participant_id.
for (const conv of conversations) {
  const p = conv.participantId ? participantById.get(conv.participantId) : null;
  conv.response = {
    …conv.existingFields,
    participantId: p?.id ?? null,
    participantKey: p?.participantKey ?? null,
    participantPhoneE164: p?.normalizedPhoneE164 ?? null,
    provider: p ? {
      name: 'openphone',
      accountId: p.providerAccountId || null,
      contactId: p.providerContactId ?? null,
      displayName: p.providerDisplayName ?? null,
      company: p.providerCompany ?? null,
    } : null,
    // legacy aliases (deprecated, remove after PR4)
    company: p?.providerCompany ?? null,
    firstName: ...,  // from snapshot via join, kept for back-compat only
    lastName: ...,
  };
}
```

The `inferCompany` heuristic ([integrations.service.ts:649-663](backend/src/modules/integrations/integrations.service.ts#L649-L663)) is preserved as a last-resort safety net for snapshots where Quo company is null — it runs against the snapshot table, and writes its result into `participant.provider_company` during the next sync cycle so we don't re-compute it on every read.

### 9.3 Perf

One `SELECT * FROM communication_participants WHERE workspace_id=? AND tenant_id=? AND provider='openphone'` (~50ms on SF-scale data) replaces up to 45 paginated `/contacts` API calls (~45s for the SF tenant today). Snapshot table is consulted only during writes (§6.4) and sync.

### 9.4 Fallback

If `participants.length === 0` for the tenant (first request post-deploy, pre-backfill):
- Log a warning `openphone cache: no participants for tenant=<id>, falling back to live`.
- Run the existing live-pagination path.
- Return.

Behavior preserved for pre-backfill tenants.

---

## 10. Backfill

Idempotent, chunked, safe to rerun. Must not only create missing rows — must **repair** existing ones.

### Endpoint

`POST /integrations/openphone/contacts/backfill` — body `{ dryRun?: boolean }`. Tenant-scoped.

### Script

`backend/scripts/backfill-openphone-contact-cache.ts` — same logic, runnable from a dev machine against prod DB. Takes `--workspace-id=… --tenant-id=… [--dry-run]`.

### Steps

**Step 1 — Sync all snapshots (Source A path):**
1.1. Sniff `provider_account_id` from OpenPhone `/phone-numbers`.
1.2. Fetch all OpenPhone contacts (paginated `/contacts`).
1.3. Normalize every phone — skip + count invalid.
1.4. For each (contact × phone): run `upsertSnapshotAndCascade` per §6.4. This both writes the snapshot AND updates any already-existing participant rows that share the phone — so *existing* participants get their provider fields (re)linked, not just new ones.

**Step 2 — Create participants for conversations that don't have one:**
2.1. `SELECT id, participant_phone_number FROM communication_conversations WHERE workspace_id=? AND tenant_id=? AND participant_id IS NULL AND participant_phone_number IS NOT NULL` (chunk 1,000).
2.2. For each row:
   - Normalize the stored participant phone → skip + count invalid.
   - Find snapshot for (workspace_id, tenant_id, phone_e164).
   - `upsertParticipant` — creating if missing, filling from snapshot if one exists (via §7.2 `resolveDisplayName`).
   - `UPDATE communication_conversations SET participant_id=…, participant_key=…, participant_phone_e164=…`.

**Step 3 — Repair participants missing provider linkage even though a snapshot exists:**
3.1. `SELECT p.id, p.normalized_phone_e164 FROM communication_participants p
      WHERE p.workspace_id=? AND p.tenant_id=? AND p.provider='openphone'
        AND p.provider_contact_id IS NULL
        AND EXISTS (SELECT 1 FROM openphone_contact_snapshot s
                    WHERE s.workspace_id=p.workspace_id AND s.tenant_id=p.tenant_id
                      AND s.phone_e164=p.normalized_phone_e164
                      AND s.provider_contact_id IS NOT NULL)` (chunk 1,000).
3.2. For each row: run the cascade update from §6.4 to fill `provider_contact_id` / `provider_display_name` / `provider_company`.
 
This step exists because participants may have been created earlier (from conversation ingest) with no snapshot available at the time. When we backfill snapshots later, cascade in §6.4 covers the happy path, but this step covers participants whose previous cascade runs were incomplete (e.g. earlier snapshot rows missing `provider_contact_id` — the data-cleanup-friendly case).

**Step 4 — Repair stale provider fields on participants:**
4.1. `SELECT p.id FROM communication_participants p
      JOIN openphone_contact_snapshot s
        ON s.workspace_id=p.workspace_id AND s.tenant_id=p.tenant_id
       AND s.phone_e164=p.normalized_phone_e164
      WHERE p.workspace_id=? AND p.tenant_id=? AND p.provider='openphone'
        AND (p.provider_contact_id   IS DISTINCT FROM s.provider_contact_id
          OR p.provider_display_name IS DISTINCT FROM resolveDisplayName(s)
          OR p.provider_company      IS DISTINCT FROM s.provider_company)`
4.2. Run cascade update from §6.4.

**Step 5 — Emit summary:** counts for snapshots created/updated, participants created/linked/repaired, conversations relinked, normalization failures.

### Requirements

- Idempotent: running twice produces no row changes on the second pass.
- Chunked: snapshots in pages of 500; conversation/participant sweeps in pages of 1,000.
- Safe to rerun: never deletes; only upserts.
- Observable: each step logs a one-line summary with counts — pipe-grep-friendly for Loki.

---

## 11. ServiceFlow Changes

### New concept: participant mapping

SF must map:

```
Sigcore participant → CRM contact
```

### Mapping logic (SF-side)

```
phone = participant.participantPhoneE164
CRM lookup → { 0 | 1 | >1 matches }
```

| Case       | Result     |
|------------|------------|
| 1 match    | mapped     |
| > 1 match  | ambiguous  |
| 0 match    | unmapped   |

### Required SF changes

- Stop treating provider contact as the root identity.
- Use `participantId` / `participantKey` as the stable identity root.
- Overlay CRM company/name on top of Sigcore's `providerCompany` / `providerDisplayName` where CRM data exists. When CRM has no match, display provider data as-is.

This is the piece that absorbs the 1,178 "no OpenPhone contact" cases — SF's own CRM knows these leads; it just needs to join by phone at display time.

---

## 12. Metrics

### Sigcore (Grafana / Loki via `{service_name="sigcore-api"}`)

- `participants_created_total` — counter (Loki: `… |= "participant created"` — parse per run).
- `participants_linked_to_provider_contact_total`.
- `participants_seen_without_provider_contact_total` — tracks the 1,178-type gap over time.
- `phone_normalization_failures_total`.
- `snapshot_rows_total{tenant_id}` — gauge via periodic DB count.
- `/conversations/all` p95 latency — expected to drop sharply post-cutover.

### ServiceFlow (SF-owned)

- `participants_mapped_total`.
- `participants_unmapped_total`.
- `participants_ambiguous_total`.

---

## 13. Rollout Plan

### PR1 — schema + normalization

- Migrations for `openphone_contact_snapshot`, `communication_participants`, and conversation FK columns.
- TypeORM entities, `IntegrationsModule` registration, common phone util.
- No write paths wired yet. Tables are empty. No behavior change.

### PR2 — sync + webhook writes

- Source A: `syncOpenPhoneContactsToCache` service + `POST /contacts/sync` endpoint + `/backfill` endpoint + script.
- Source B: webhook handler extension (guarded by Open Question 16.2 — if events don't exist, noop).
- Source C: conversation-ingest writes participant rows and links conversations on every sync/webhook path.
- Run backfill in staging + prod tenant-by-tenant. Verify row counts.

### PR3 — read path cutover

- `getAllOpenPhoneConversations` reads from `openphone_contact_snapshot` + joins participants.
- Conversation response includes `participantId` / `participantKey` / `participantPhoneE164` / `providerContactId` / `providerDisplayName` / `providerCompany`.
- Legacy fields (`company`, `firstName`, `lastName`) retained as aliases with a deprecation note.
- Live-pagination fallback preserved for empty-cache case.
- `GET /integrations/openphone/participants` endpoint shipped.

### PR4 — SF mapping update

- SF consumes `participantId` / `participantKey`, layers CRM overlay.
- SF reports `participants_mapped_total` / `_unmapped_total` / `_ambiguous_total`.
- SF stops relying on `company` / `firstName` / `lastName` directly.

---

## 14. Acceptance Criteria

### Sigcore

- [ ] Every conversation in `/conversations/all` has `participantId`, `participantKey`, `participantPhoneE164` populated.
- [ ] Every valid-phone participant has a `communication_participants` row.
- [ ] Participants link to their provider contact when a snapshot exists for the phone.
- [ ] No tenant-writable CRM fields exist.
- [ ] `/conversations/all` p95 latency drops by ≥80% for the SF tenant vs. live-pagination baseline.
- [ ] Backfill run in staging produces expected counts (SF: ≈2,186 snapshots, ≈3,413 participants with ≈2,058 having `provider_contact_id` set).

### ServiceFlow

- [ ] Identity mapping keyed on `participantId`, not on provider contact.
- [ ] No duplicate identities per `(tenant, phone)`.
- [ ] Unmapped rate measurable and reported; closing the 1,178-gap becomes an SF-side CRM data-quality task, not a Sigcore task.

---

## 15. Non-goals

- No CRM logic in Sigcore.
- No tenant enrichment storage.
- No contact field ownership by Sigcore beyond provider mirror.
- No provider mutation from Sigcore (no creating Quo contacts).
- No precedence matrix (only one source per field — the provider).

---

## 16. Open questions

1. **`libphonenumber-js` dependency.** Needs approval + bundle-size review. Not a blocker — ship US-only (prepend `+1` to last-10) in PR1 and harden later.
2. **Does OpenPhone emit `contact.created` / `contact.updated` / `contact.deleted` webhooks?** Existing [webhooks.service.ts:214](backend/src/modules/webhooks/webhooks.service.ts#L214) handles only `message.*` and `call.*`. If contact events don't exist, Source B collapses into "on-demand sync only" — revisit scheduling. Not a blocker for MVP.
3. **Periodic resync cadence.** On-demand + end-of-`/integrations/sync` covers the common case. Do we want a Railway cron from day one? Product call. Not a blocker.
4. **Participant in provider-agnostic core entity or OpenPhone-specific?** Current design is provider-agnostic (`provider` column) so Twilio/WhatsApp fit later. If we ever need per-provider columns (e.g. `provider_account_id`), they go on snapshots; participants stay minimal.
5. **Relationship to repo-root sister plan** [../SIGCORE_OPENPHONE_CORRELATION.md](../SIGCORE_OPENPHONE_CORRELATION.md). That doc describes the participant layer at a higher level; this plan is the implementation. Sunset the root-level doc or reduce it to a pointer once this ships.

None of the open questions block MVP delivery.

---

## 17. Final Architecture Summary

**Sigcore:**
- Normalizes **communication identity** (phone-based endpoints per provider account) — NOT person identity.
- Links conversations ↔ provider contacts when both exist in the same provider account.
- Caches provider data.
- Does NOT own business meaning.
- Keeps the door open for future provider-agnostic participant merging (cross-provider "same person" correlation) but does **not** implement it now — `communication_participants.provider` and `.provider_account_id` scope today; a separate `person_id` column could later merge across providers without schema pain.

**ServiceFlow:**
- Owns customer/lead identity.
- Owns company/name CRM truth.
- Maps participants → CRM contacts.

---

## 18. Critical files for implementation

- [backend/src/database/entities/openphone-contact-snapshot.entity.ts](backend/src/database/entities/openphone-contact-snapshot.entity.ts) — NEW.
- [backend/src/database/entities/communication-participant.entity.ts](backend/src/database/entities/communication-participant.entity.ts) — NEW.
- [backend/src/database/entities/communication-conversation.entity.ts](backend/src/database/entities/communication-conversation.entity.ts) — add `participantId`, `participantKey`, `participantPhoneE164`.
- [backend/src/database/migrations/1752000000000-OpenPhoneContactSnapshot.ts](backend/src/database/migrations/1752000000000-OpenPhoneContactSnapshot.ts) — NEW.
- [backend/src/database/migrations/1752000100000-CommunicationParticipants.ts](backend/src/database/migrations/1752000100000-CommunicationParticipants.ts) — NEW.
- [backend/src/database/migrations/1752000200000-ConversationParticipantFk.ts](backend/src/database/migrations/1752000200000-ConversationParticipantFk.ts) — NEW.
- [backend/src/common/util/phone.ts](backend/src/common/util/phone.ts) — NEW single canonical normalization util.
- [backend/src/modules/integrations/integrations.service.ts](backend/src/modules/integrations/integrations.service.ts) — `getAllOpenPhoneConversations` read path (line 553); new `syncOpenPhoneContactsToCache`.
- [backend/src/modules/integrations/integrations.controller.ts](backend/src/modules/integrations/integrations.controller.ts) — new `/contacts/sync`, `/contacts/backfill`, `/participants` routes.
- [backend/src/modules/integrations/integrations.module.ts](backend/src/modules/integrations/integrations.module.ts) — register new entities in `TypeOrmModule.forFeature`.
- [backend/src/modules/communication/communication.service.ts](backend/src/modules/communication/communication.service.ts) — conversation-ingest Source C: upsert participant + link conversation.
- [backend/src/modules/webhooks/webhooks.service.ts](backend/src/modules/webhooks/webhooks.service.ts) — `handleOpenPhoneWebhook` extension for Source B contact events (line 214).
- [backend/scripts/backfill-openphone-contact-cache.ts](backend/scripts/backfill-openphone-contact-cache.ts) — NEW.
