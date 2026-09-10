# Sigcore task backlog — OpenPhone/Quo conversation-sync bugs

**Discovered 2026-09-08 while unblocking LB tenant ABC Solutions (userId `96b8da2a-3a59-46f5-b156-cb3e98fd7b81`, Sigcore tenant `d471a324-8489-45f9-88af-2955d7d97db4`).**

Full context in [LB Obsidian → LeadBridge → "Quo conversation-sync path"], but the short version: LB's `ConversationSyncService.hydrateLeadFromQuo` + `matchLeadConversations` rely on Sigcore's OpenPhone integration to be the single provider abstraction for tenant-owned Quo workspaces. LB just calls Sigcore's `/conversations` and `/conversations/:id/messages` and projects the results into its canonical `Message` table. The findings below block that pipeline for ABC (and expose data-integrity risks that likely affect other tenants).

There are **8 tasks**, ordered by severity.

## Status

| # | Status | Title |
|---|---|---|
| 1 | ✅ shipped `db2af51` | Cross-tenant leak on `/conversations/:id/messages` |
| 2 | ✅ shipped `4b709c6a` + Bug 6 fix `1c660aa7` | Sync `tenant_id` mis-attribution + `linkOpenPhoneParticipant` bypass |
| 3 | ✅ shipped `4b709c6a` | `skipReasons` bucket |
| 4 | ✅ shipped `4b709c6a` | Auth guard header trim |
| 5 | ✅ shipped `4b709c6a` | `GET /integrations/openphone` endpoint |
| 6 | ✅ shipped `4385b81d` | Extractor null-safety on lookup miss |
| 7 | ✅ shipped `eb61a9e1` | Tenant-scoped credential resolution in `syncConversations` |
| 8 | ✅ **fix landed** (see "Fix landed" block under Task 8) | OpenPhone extractor now tenant-scopes phone map + post-filters conversations |

**Correction (2026-09-10):** an earlier revision of this doc claimed "all closed, LB-direct pilot picks up the slack." That LB-direct pilot violated the "no comms in LB" architectural rule and was reverted (LB commits `300d8b4b` + `1ffd689a` — both reverted as `82e5f2b2` + drop-columns migration `0a0412d5`, ABC's Quo message webhook `WH9d4ac7c3…` deleted). **Task 8 below is the actual work needed to unblock ABC via the Sigcore-mediated path.**

---

## Task 1 — 🚨 SECURITY / CORRECTNESS — cross-tenant leak on `GET /conversations/:id/messages`

**Severity**: P0 — blocks LB Quo conversation-sync rollout for ABC, potential data leak between tenants that share phone numbers.

### Repro (deterministic — reproduced twice, ~15h apart)

1. Sigcore tenant `d471a324-8489-45f9-88af-2955d7d97db4` (ABC Solutions):
   - `POST /api/integrations/openphone/connect` with ABC's Quo API key ✓
   - `POST /api/integrations/sync {syncMessages: true}` ✓ — completes with `conversationsSynced: 2720, messagesSynced: 89`
2. `GET /api/conversations?limit=200&page=1` (auth: ABC's `x-api-key`) returns **1** conversation:
   ```
   { id: "565a2536-1930-4447-89aa-cfddc31a28d1",
     participantPhoneNumber: "+14256756379",         // ABC's cleaner Kevin's cell (their CC agent phone)
     lastMessageAt: "2026-09-08T15:24:30Z" }
   ```
3. `GET /api/conversations/565a2536-1930-4447-89aa-cfddc31a28d1/messages` (same auth) returns:
   ```json
   {
     "id": "c4324488-d9a2-4a49-924a-29d0ffd38633",
     "conversationId": "721787da-9d57-454a-bb36-4345850cb36a",   ← DIFFERENT from URL
     "direction": "out",
     "body": "Lead steve joo replied: \"Okay. can you do it on 7/22?\"",
     "fromNumber": "+12064663099",                                 ← different tenant's Sigcore number
     "toNumber": "+14256756379",                                   ← ABC's agent phone
     "metadata": {
       "type": "re-engagement",
       "userId": "c270d06d-2de6-425f-bdfb-47dd8231c626",           ← NOT ABC
       "tenantId": "20013407-ecba-4001-a529-42336217e882",         ← NOT ABC's tenant (d471a324)
       "savedAccountId": "ab2e350c-b94e-4309-b620-74..."           ← NOT ABC
     }
   }
   ```

The `conversationId` field on the message (`721787da…`) doesn't equal the `:id` URL param (`565a2536…`), and the message's `metadata.tenantId` (`20013407…`) doesn't equal the requesting API key's tenant (`d471a324…`).

### Root-cause hypothesis

`/conversations/:id/messages` is filtering `messages` by **the phone pair `(fromNumber, toNumber)` extracted from the conversation record**, not by `conversation_id + tenant_id`. Since `+14256756379` is used by two tenants (ABC as their Call Connect agent phone, tenant `20013407` as a customer phone their re-engagement SMS targets), the query returns rows scoped to a phone number rather than to the tenant's own conversation.

Both tenants have `+14256756379` in their message-participant history for entirely different reasons:
- Tenant `20013407` sends re-engagement SMS to `+14256756379` from their Sigcore number `+12064663099` (customer)
- ABC uses `+14256756379` as their cleaner's callback phone (agent)

The read query joins the two.

### Expected behavior

`GET /conversations/:id/messages` must return **only** messages where `messages.conversation_id = :id AND messages.tenant_id = <caller's tenant>`. The tenant scope is authoritative; phone-pair joins are wrong for a multi-tenant system.

### Suggested fix direction

- Verify the SQL/query builder for `MessagesService.listByConversation(convId)` scopes by both `conversation_id` and `tenant_id` (the latter from the auth context, not from any client input).
- Add a regression test that seeds two conversations in different tenants that share a phone number and asserts that `GET /conversations/:idA/messages` returns only tenant A's messages.
- Audit any other read endpoints that resolve messages by phone rather than by scoped ID: `/conversations` list, `/calls`, `/threads/*` if they exist.

### Blast radius

Any two LB tenants who happen to share a phone number in any message's `from`/`to` will see each other's messages via Sigcore. This includes:
- Tenants whose Sigcore-issued number was previously assigned to a different tenant's lead
- Tenants who use a shared human's phone as an agent (e.g., a cleaner working for multiple LB tenants — real scenario in the home-services vertical)
- Any tenant using LB-authored SMS to any customer whose phone another tenant has ever texted

---

## Task 2 — 🔴 CORRECTNESS — sync writes leave `communication_conversations.phone_number` empty; read filter drops rows

**Severity**: P1 — the entire OpenPhone/Quo integration is unusable via the read API. LB's `matchLeadConversations` and `hydrateLeadFromQuo` iterate this endpoint; if it returns 1 of thousands, no leads get matched.

### Root cause (identified via direct DB inspection 2026-09-08)

Two-layer bug. First, the **sync write path** does not correctly resolve which of the tenant's OpenPhone numbers hosts each conversation:

```sql
-- ABC's actual state in the DB:
SELECT COUNT(*) FILTER (WHERE tenant_id = 'd471a324-…') AS by_tenant,
       COUNT(*) FILTER (WHERE workspace_id = '1bcbb4e0-…') AS by_workspace,
       COUNT(*) FILTER (WHERE tenant_id IS NULL AND workspace_id = '1bcbb4e0-…') AS orphan
  FROM communication_conversations;
-- Result: by_tenant=102, by_workspace=6700, orphan=718
```

Then, within those 102 ABC-scoped rows, sample rows look like:

```
participant_phone_number: '+13016845242'  ← customer (populated OK)
phone_number:             '+18139212100'  ← tenant side (WRONG — not in ABC's tenant_phone_numbers)
participant_phone_number: '+19044307053'
phone_number:             ''               ← tenant side (EMPTY)
```

ABC's actual OpenPhone-provider `tenant_phone_numbers` are only `+14254064045` and `+14256756379`. But most conversation rows have `phone_number` empty or pointing at a completely unrelated number.

Second, the **read endpoint** correctly applies `applyConvTenantPhoneScope()` (the same route-by-phone UNION from the Task 1 fix) — but that scope requires `phone_number IN (tenant_phone_numbers)`, which filters out the vast majority of ABC's rows.

Only 1 conversation survives the filter: the one where `phone_number = +14255528200` (ABC's Twilio bot number for Call Connect notifications). That's the "1 of 2720" the user sees.

### Related: `conversationsSynced: 2720` is misleading

The sync-status counter reports 2720 rows processed but only 102 ended up in the DB with `tenant_id = ABC`. The other ~2618 either:
- Got NULL `tenant_id` (the 718 orphan-workspace rows)
- Were deduped against pre-existing shared workspace rows
- Silently failed the attribution step

Should be renamed to `rowsProcessed` and paired with `rowsAttributedToTenant`.

### Fix direction

1. **Sync write path** — for each Quo conversation being ingested for tenant T, look up which participant is one of T's owned OpenPhone numbers:
   ```sql
   -- Pseudo-logic in the sync ingester
   FOR EACH quo_conversation:
     tenant_side = FIRST participant IN (
       SELECT phone_number FROM tenant_phone_numbers
        WHERE tenant_id = :T AND provider = 'openphone'
     )
     IF NOT FOUND: skip with reason 'no_owned_participant_phone' (feeds Task 3)
     ELSE:
       INSERT ... SET
         phone_number = tenant_side,
         participant_phone_number = <the other participant>
   ```
2. **Add a retroactive backfill script** for ABC (and any other tenant that ran an OpenPhone sync before this fix) that re-scans `communication_conversations WHERE tenant_id = T AND phone_number NOT IN (tenant_phone_numbers)` and re-attributes `phone_number` where possible.
3. **Rename `conversationsSynced` → `conversationsAttributed`** in the sync-status result, and add `conversationsProcessed` alongside.

### Blast radius

Any tenant that ran an OpenPhone connect + sync via LB (or the same underlying API) currently has broken read-side visibility. Only ABC is known to be affected right now (Spotless Homes uses Sigcore's own OpenPhone workspace with different sync semantics), but any new tenant onboarding via LB's Flow A will hit this immediately.

### Verification once fixed

Re-run:
```bash
curl -sS "https://sigcore-production.up.railway.app/api/conversations?limit=200&page=1" \
  -H "x-api-key: <ABC key>"
```
Expected: `meta.total ≈ 102` (matching ABC's `by_tenant_id` count), each conversation carrying `participant_phone_number = <customer>` and `phone_number ∈ {+14254064045, +14256756379}`.

### Repro

Same setup as Task 1. After a successful `/api/integrations/sync` completes with `conversationsSynced: 2720`, calling `GET /api/conversations?limit=200&page=1` returns:

```json
{
  "data": [ /* 1 item */ ],
  "meta": { "page": 1, "limit": 200, "total": 1, "totalPages": 1 }
}
```

But the sync-status report claims **2720 conversations synced**:

```json
{
  "status": "completed",
  "current": 2720, "total": 2720,
  "message": "Synced 2720 conversations, 89 messages, 156 calls",
  "result": {
    "conversationsFromProvider": 4449,
    "conversationsSynced": 2720,
    "messagesSynced": 89,
    "callsSynced": 156,
    "contactsLinked": 0,
    "contactsCreated": 0,
    "errors": 0,
    "conversationsSkipped": 1729
  }
}
```

### Root-cause hypothesis

Either:
- (a) The `/conversations` list filters by presence of messages (`WHERE EXISTS (SELECT 1 FROM messages WHERE conversation_id = conversations.id)`), and only 1 of the 2720 has messages attributed to ABC's tenant — combined with Task 1, that "1" is actually a leaked cross-tenant match.
- (b) There's a `participantPhoneNumber IS NOT NULL` filter and only 1 conversation had its participant column populated during sync.
- (c) Same tenant-scoping issue as Task 1: the list is scoping incorrectly and coincidentally only 1 row survives whatever filter it applies.

Any of these makes the read side unusable.

### Expected behavior

`GET /conversations` should return N ≈ 2720 (matching `conversationsSynced`), scoped to the caller's tenant, ordered by `lastMessageAt DESC`.

### Suggested fix direction

- Confirm which filter narrows 2720 → 1 in ABC's case; remove or reconsider it.
- If the filter is intentional (e.g., "only show conversations with resolved contacts"), then either:
  - Return the raw count in `meta` (e.g., `meta.total_including_hidden = 2720`) so consumers can detect the surfacing gap, OR
  - Add a `?includeUnresolved=true` query param so LB can pull them all for its own matching.
- Related: fix `contactsLinked: 0, contactsCreated: 0` in the sync result — 2720 conversations with 0 contacts means the contact resolver isn't running, which is likely why so few conversations are surfaced.

---

## Task 3 — 🟡 OBSERVABILITY — `conversationsSkipped: 1729` has no reason surface

**Severity**: P2 — makes it impossible to diagnose why 39% of provider conversations don't get synced.

### Repro

ABC's sync result at the top of Task 2 shows `conversationsFromProvider: 4449, conversationsSynced: 2720, conversationsSkipped: 1729` — but no per-conversation reason codes, no counts by reason, nothing.

For ABC we can't tell whether the 1729 were:
- Beyond a retention window (e.g., older than 90 days)
- Missing required fields (no participant phone, no timestamps)
- Filtered as spam by an internal Sigcore rule
- Blocked by rate-limit / provider errors that weren't counted in `errors: 0`

### Expected behavior

`sync/status.result` should include a `skipReasons: { <reason>: <count>, ... }` breakdown. Example:

```json
"conversationsSkipped": 1729,
"skipReasons": {
  "retention_window_exceeded": 1600,
  "no_participant_phone": 120,
  "provider_error": 9
}
```

Plus, ideally, a `/integrations/sync/skipped?reason=X&limit=100` endpoint that returns actual conversation-id samples so we can spot-check them.

### Suggested fix direction

- Add a reason enum to the sync engine's skip branches.
- Aggregate on the sync-run row.
- Surface in the status response and (Layer 2) in the dashboard.

---

## Task 4 — 🟡 AUTH — `GET /integrations/sync/status` returns 401 sometimes with valid `x-api-key`

**Severity**: P2 — inconsistent auth behavior, blocks tooling.

### Repro

With ABC's `sigcoreApiKey` (74-char string, sha256[0:8]=`5a2337e8`):
- `GET /api/conversations?limit=1 → 200 OK` ✓
- `GET /api/integrations/sync/status → 200 OK` (from LB's `_abc-probe-sigcore.ts` script) ✓
- Same `GET /api/integrations/sync/status → 401 "Authentication required. Provide X-Sigcore-Key or x-api-key header."` (from ad-hoc `curl` invocations in the same session)

The 401 message specifies `X-Sigcore-Key` OR `x-api-key`. Both header names in the same guard is a smell — one path may bypass the guard, another may require a different header name.

### Expected behavior

If both `X-Sigcore-Key` and `x-api-key` are accepted, all `/integrations/*` endpoints should accept both consistently. If only `X-Sigcore-Key` is accepted on `sync/status` and `x-api-key` elsewhere, either the auth guard is buggy or the docs are lying.

### Suggested fix direction

- Grep for `X-Sigcore-Key` and `x-api-key` in Sigcore's request pipeline. Consolidate to one guard that accepts both, or standardize on one and update the 401 message + docs.

---

## Task 5 — 🟢 API SHAPE — `GET /integrations/openphone` returns 404

**Severity**: P3 — minor, discovered while trying to inspect connection state.

`GET /api/integrations/openphone` returns 404 for ABC's tenant. Would be useful to have this endpoint return the current OpenPhone/Quo connection state (workspace ID, connected phone numbers, provider status) so LB and other consumers can render "connected/not connected" without inferring it from side-channel state.

Related: LB currently calls `POST /api/integrations/openphone/connect` (200 works) and `POST /api/integrations/openphone/numbers` (works). A `GET` companion is a natural addition.

---

## Task 6 — 🔴 CORRECTNESS — OpenPhone `phone_number` extractor emits `''` on lookup miss, sync overwrites good data

**Severity**: P1 — one Quo pagination/lookup glitch during resync silently corrupts a previously-attributable conversation to an unreadable state. Complements Task 2 (which handles `tenant_id` attribution, but does not protect `phone_number` itself on the update path).

### Root cause (identified 2026-09-09 while reviewing Task 2 & Bug 6 completeness)

Two-layer defect on the write path, both silent:

1. **Extractor** — [backend/src/modules/communication/providers/openphone.provider.ts:286-317](backend/src/modules/communication/providers/openphone.provider.ts#L286-L317)
   ```ts
   const phoneNumberId = conv.phoneNumberId as string;
   const phoneInfo = phoneNumberMap.get(phoneNumberId);
   // …
   return {
     externalId: conv.id as string,
     phoneNumber: phoneInfo?.number || '',   // ← empty when lookup misses
     participantPhoneNumber: participants[0] || '',
     participantPhoneNumbers: participants,
     // …
   };
   ```
   When `phoneNumberMap.get(phoneNumberId)` returns `undefined` — deleted phone in Quo, transient `/phone-numbers` API failure caught by the `try/catch` at [openphone.provider.ts:170-172](backend/src/modules/communication/providers/openphone.provider.ts#L170-L172) (which returns an empty map, not an error), or a phone paginated out of the reply — the extractor emits `phoneNumber: ''`. A single `warn` log is the only signal.

2. **Sync writer** — [backend/src/modules/communication/communication.service.ts:2054-2065](backend/src/modules/communication/communication.service.ts#L2054-L2065)
   ```ts
   } else {
     if (tenantId && !conversation.tenantId && convPhoneOwnedByTenant) {
       conversation.tenantId = tenantId;
     }
     conversation.metadata = convData.metadata;
     conversation.phoneNumber = convData.phoneNumber;               // ← unconditional overwrite
     conversation.participantPhoneNumbers = convData.participantPhoneNumbers;
   }
   ```
   On the EXISTING-row branch, `phoneNumber` is unconditionally overwritten with the extractor's output. So a resync where Quo momentarily can't resolve one `phoneNumberId` overwrites a correctly-attributed row's `phone_number = '+14254064045'` → `phone_number = ''`. The row still has `tenant_id = ABC`, but every read filters it out via `applyConvTenantPhoneScope` (Task 1 fix), since `'' ∉ ABC's tenant_phone_numbers`.

The Task 2 sync-loop guard (`convPhoneOwnedByTenant`) fires on NEW rows and gates `tenantId` backfill — but does not gate the `phoneNumber` overwrite on existing rows.

### Repro (post-Task-2)

Simulate a Quo lookup miss for one of ABC's `phoneNumberId` values (either delete a phone in Quo, or induce a `/phone-numbers` fetch failure), then re-run `POST /api/integrations/sync {syncMessages: true}` for ABC. Expected pre-fix behavior:
- N previously-visible conversations whose `phoneNumberId` was the affected one now return `phone_number = ''` in the DB.
- `GET /api/conversations` count for ABC drops by exactly N.
- `SyncResult.skipReasons` shows no new skips — the corruption is silent.

### Expected behavior

An extractor-side lookup miss MUST NOT clobber a previously-good `phone_number`. Two independent invariants:

1. **Extractor**: when `phoneInfo` is missing, do not emit an empty tenant-side phone. Either (a) return the conversation with `phoneNumber: null` and let the sync loop skip with a new reason, or (b) drop the conversation before it reaches the sync loop (still surface the count as a skip reason).
2. **Sync writer**: on the EXISTING-row branch, only overwrite `conversation.phoneNumber` when the new value is non-empty AND (for tenant-scoped callers) owned by the tenant. Never overwrite good data with empty. Symmetric to the `tenant_id` guard already in place.

### Fix direction

1. Change the OpenPhone extractor to return `phoneNumber: string | null` — `null` when `phoneInfo` is missing — and thread that nullability into the sync loop's `convData.phoneNumber` type.
2. In the sync loop:
   - Add a new `SyncSkipReason: 'phone_number_unresolved'` for the case where the extractor can't determine the tenant-side phone.
   - On the NEW-row branch: if `convData.phoneNumber` is falsy, `bumpSkip('phone_number_unresolved')` and `continue`.
   - On the EXISTING-row branch: only overwrite `conversation.phoneNumber` when `convData.phoneNumber` is a non-empty string AND `convPhoneOwnedByTenant` (mirroring the existing `tenantId` guard). Otherwise leave the stored value intact.
3. Add regression coverage:
   - Extractor: `phoneInfo` missing → returns `phoneNumber: null` and logs a warning.
   - Sync loop: existing row with a good `phone_number` + inbound `convData.phoneNumber = ''` → row is preserved, no overwrite, no attribution change.
   - Sync loop: new conversation with `convData.phoneNumber = ''` → skipped, `skipReasons['phone_number_unresolved'] === 1`.

### Blast radius

Any workspace where the tenant's Quo API key has ever returned a partial `/phone-numbers` reply (rate-limits, deleted phones, or transient 5xx swallowed by the extractor's warn-and-return path) is at risk of silently losing attribution on any subset of its conversations. Symptom is identical to Task 2: `/conversations` returns a subset that shrinks each time an unlucky resync runs. Distinguishable from Task 2 only by whether the affected rows had a *previously-correct* `phone_number` (Task 6) vs never one (Task 2).

### Verification once fixed

```bash
# Force an extractor miss (delete + resurrect a phone in Quo, or block /phone-numbers), then:
curl -sS -X POST "https://sigcore-production.up.railway.app/api/integrations/sync" \
  -H "x-api-key: $SIGCORE_KEY" -H "Content-Type: application/json" \
  -d '{"syncMessages": true}'

# Poll:
curl -sS "https://sigcore-production.up.railway.app/api/integrations/sync/status" \
  -H "x-api-key: $SIGCORE_KEY"
# Expected: result.skipReasons.phone_number_unresolved > 0, no drop in /conversations count.

curl -sS "https://sigcore-production.up.railway.app/api/conversations?limit=200&page=1" \
  -H "x-api-key: $SIGCORE_KEY"
# meta.total unchanged vs pre-sync (no rows corrupted to phone_number='').
```

---

## Task 7 — ✅ SHIPPED (`eb61a9e1`) — tenant-scoped credential resolution in `syncConversations`

**Root cause (user's own analysis, corrected mine)**: `syncConversations` called `getIntegration(workspaceId, provider)` which reads only `communication_integrations` (workspace-scoped, no tenant filter). ABC's per-tenant Quo credentials, stored in `tenant_integrations` by `connectOpenPhoneForTenant`, were ignored. ABC's sync ran under whichever tenant's key seeded the shared workspace first (a sibling), Quo returned that sibling's data, and Task 2's phone-ownership guard correctly rejected everything.

**Fix (shipped 2026-09-09):**
- `resolveIntegrationForCaller(workspaceId, tenantId, provider)` — tenant-first, workspace-fallback (mirrors the pattern in `sendMessageToPhoneNumber` at `communication.service.ts:999-1005`).
- `syncConversations` now uses the new resolver.
- `OpenPhoneContactCacheService.resolveOpenPhoneTenant` audit-fixed with the same shape bug (newest-tenant heuristic in shared workspaces). New optional `phoneNumber` param routes to the tenant that owns the phone via `tenant_phone_numbers`.
- 4 new regression tests (417/417 suite pass).

**Verification post-deploy (2026-09-09):** `GET /integrations/openphone` for ABC correctly returns `integrationId: eea2f538…` (ABC's `tenant_integrations` row) and `ownedPhoneNumberCount: 2`. Credential resolution end-to-end works.

**But**: even with the right credentials, ABC's `/conversations` still returned 1 (unchanged). Investigation of the workspace state showed the sync IS running with ABC's key but the OpenPhone provider's `phone_number` values still land as foreign. That's Task 8 below.

---

## Task 8 — ✅ FIX LANDED (2026-09-10) — OpenPhone extractor now tenant-scopes phone map + post-filters conversations

### Fix landed (staged, awaiting deploy)

**What shipped** (backend, on current branch, pre-commit):

1. **`backend/src/modules/communication/interfaces/communication-provider.interface.ts`** — `getConversations` gained an optional 5th param `allowedPhoneNumberIds?: Set<string>` with a doc-comment mandating (a) phone-map scoping and (b) conv-list post-filtering when set.
2. **`backend/src/modules/communication/providers/openphone.provider.ts`** — implementation:
   - After building the workspace-wide `phoneNumberMap` from `/phone-numbers`, entries whose id is not in `allowedPhoneNumberIds` are stripped. Foreign phones can no longer be emitted as a tenant-side `phoneNumber` for shared workspaces.
   - After fetching `/conversations`, the array is post-filtered by `conv.phoneNumberId ∈ allowedPhoneNumberIds` — defense against Quo's lax server-side filter (verified 2026-09-10: `phoneNumbers=X` and `phoneNumbers=Y` returned identical top-5 for ABC's key).
   - `getConversationsFromMessages` short-circuits (returns `[]`) when the caller-supplied `phoneNumberId` isn't in the allowed set.
3. **`backend/src/modules/communication/providers/twilio.provider.ts`** — accepts the new param and ignores it (Twilio has no analogue to workspace-scoped `phoneNumberId`).
4. **`backend/src/modules/communication/communication.service.ts`** — `syncConversations` loads the caller-tenant's owned OpenPhone `provider_id`s from `tenant_phone_numbers` and passes them as `allowedPhoneNumberIds` for OpenPhone syncs. Only applied when `tenantId` is set (workspace-scoped callers still see everything). Logs `[SYNC OWN-IDS]` counts and warns loudly when the tenant has zero owned providerIds (indicating `registerOpenPhoneNumbersForTenant` didn't run at connect time).
5. **`backend/src/modules/communication/providers/openphone.provider.phone-extractor.spec.ts`** — 4 new tests under `describe('Task 8 — tenant-scoped allowedPhoneNumberIds')`:
   - Scopes phoneNumberMap AND conv-list to allowed set (foreign convs dropped, owned convs carry own phone).
   - Strips ALL convs when no id matches.
   - Post-filters even when Quo returns ids outside the filter (lax-filter defense).
   - No-op when allowedPhoneNumberIds is not provided (workspace-scoped caller regression guard).

**Test status**: `npx jest --no-coverage` — 94 suites / **1213 tests pass**, no regressions. TypeScript `noEmit` clean (only pre-existing unrelated error: missing `@fixprompt/node` types in `main.ts`).

**Deploy verification steps** (post-Railway deploy):

```bash
# 1. Kick off a fresh ABC sync with the tenant-scoped Sigcore key
curl -sS -X POST "https://sigcore-production.up.railway.app/api/integrations/sync" \
  -H "x-api-key: <ABC's sigcore key>" -H "Content-Type: application/json" \
  -d '{"syncMessages": true}'

# 2. Poll status — expect `[SYNC OWN-IDS] tenant=d471a324... owns 2 OpenPhone providerIds` in logs
curl -sS "https://sigcore-production.up.railway.app/api/integrations/sync/status" \
  -H "x-api-key: <ABC's sigcore key>"

# 3. List conversations — expect ~200+ rows (vs. 1 pre-fix), all phone_number ∈ {+14254064045, +14256756379}
curl -sS "https://sigcore-production.up.railway.app/api/conversations?limit=200&page=1" \
  -H "x-api-key: <ABC's sigcore key>"
```

**Backfill note**: pre-existing rows in `communication_conversations` for ABC that were previously written with foreign `phone_number` values will NOT be corrected by this fix on their own (the update branch's Task-6 guard prevents an unresolved extractor result from overwriting a stored value, but on the tenant-scoped write path the extractor now correctly returns owned values for ABC's own conversations, so NEW rows land correctly and prior mis-attributed rows in the workspace stay tagged to whichever tenant owned them originally). If backfill is needed, a one-shot resync following the fix should suffice since ABC has almost no attributable rows today.

### Original problem statement (kept for context)

**Severity**: P1 — with Task 7 confirmed shipped and credential resolution verified correct, the extractor still writes `phone_number` values that DON'T match the caller-tenant's owned phones. `applyConvTenantPhoneScope` then correctly filters those rows out, so the tenant's own conversations remain invisible via `/conversations`.

### Discovery (2026-09-09 post-Task 6 deploy `4385b81d`)

After Task 6 shipped, I re-ran ABC's sync and inspected the workspace-wide state. Task 2 guard + Task 6 null-safety together correctly prevented data pollution — no more mis-attributions to ABC's `tenant_id`. But the underlying **`phone_number` mis-mapping** for ABC's Quo conversations remained.

Direct probe of ABC's Quo API returns 100 conversations per ABC-owned phoneNumberId:

```bash
# ABC's OpenPhone-provider tenant_phone_numbers:
#   +14254064045 (phoneNumberId=PN2Av4NWo1)
#   +14256756379 (phoneNumberId=PNyi7fw8ye)

curl -s "https://api.quo.com/v1/conversations?phoneNumberId=PN2Av4NWo1&maxResults=100" \
  -H "Authorization: $ABC_QUO_API_KEY" | jq '.data | length'
# → 100  (real conversations exist; e.g. participants=["+13048262438"], lastActivityAt=2026-09-09T01:38Z)

curl -s "https://api.quo.com/v1/conversations?phoneNumberId=PNyi7fw8ye&maxResults=100" \
  -H "Authorization: $ABC_QUO_API_KEY" | jq '.data | length'
# → 100
```

Simultaneously, Sigcore's DB shows **only 1 conversation across the entire workspace** whose `phone_number ∈ ABC-owned-set` (that 1 is a Twilio Call-Connect notification channel, not an OpenPhone conversation). The ~200+ real OpenPhone conversations Quo returns for ABC's two phones land in `communication_conversations` with `phone_number = '+18139212100'` (foreign — belongs to tenant `0361e158`) or other unrelated phones.

Bonus signal: the two `phoneNumberId` filters above returned the **identical top-5 conversation IDs**, suggesting Quo may be ignoring `phoneNumberId` as a filter param (or applying it laxly). Whatever Sigcore's extractor is joining against to derive the tenant-side `phone_number`, it's picking the wrong phone.

### Root cause hypothesis

The extractor at [openphone.provider.ts:286-317](backend/src/modules/communication/providers/openphone.provider.ts#L286-L317) resolves `phoneNumber` via:

```ts
const phoneNumberId = conv.phoneNumberId as string;
const phoneInfo = phoneNumberMap.get(phoneNumberId);
// …
phoneNumber: phoneInfo?.number ?? null,   // Task 6 null-safe
```

`phoneNumberMap` is built at [openphone.provider.ts:~165](backend/src/modules/communication/providers/openphone.provider.ts) from a workspace-level `getPhoneNumbers()` call. For a **shared** OpenPhone workspace (ABC's), that reply likely contains phones owned by multiple tenants — and the `phoneNumberId → phone` mapping isn't scoped by the caller's tenant. So `phoneNumberMap.get('PN2Av4NWo1')` may return `+18139212100` (a foreign tenant's phone that happens to be under the same Quo workspace id abstraction) instead of `+14254064045` (ABC's actual phone for that id).

Alternate hypothesis: Quo returns `conv.phoneNumberId` as some workspace-shared identifier, and Sigcore's extractor picks the first matching entry from a stale/unfiltered cache.

Either way, the extractor is not producing per-conversation-correct `phone_number` values for shared-workspace tenants.

### Blast radius

Any tenant whose Sigcore-mediated OpenPhone workspace is shared with another tenant (which appears to be the norm for LB tenants routed through Sigcore) has this problem. The read side (Task 1 fix's `applyConvTenantPhoneScope`) then correctly filters their own conversations OUT as unowned. Result: the tenant sees `/conversations = 0-1` even though hundreds of real conversations exist and were ingested.

ABC is the canary. Every LB tenant onboarded to Sigcore-mediated OpenPhone conversation sync will hit this.

### Fix direction

1. **Scope `phoneNumberMap` by the caller's tenant.** When building the workspace-wide phone-number lookup at extractor time, join against `tenant_phone_numbers WHERE workspace_id = <workspace> AND tenant_id = <caller_tenant>`. If a `phoneNumberId` from Quo doesn't match any tenant-owned phone, skip the conversation with `phone_number_unresolved` (Task 3's reason bucket) — do NOT fall back to another tenant's phone.

2. **Verify Quo's `phoneNumberId` filter is actually being applied.** The identical-response-for-different-filters signal above suggests Quo may be returning all workspace conversations regardless of the filter. Contact Quo support or read the API docs to confirm. If Quo ignores the filter for accounts with multi-workspace access, Sigcore must post-filter locally by `conv.phoneNumberId ∈ <caller-tenant's phoneNumberIds>`.

3. **Add regression test** at `openphone.provider.phone-extractor.spec.ts`: seed a workspace with two tenants, each owning distinct OpenPhone numbers with distinct `phoneNumberId`s; verify `getConversations(callerTenantA)` only emits conversations whose `phoneNumber` is one of tenant A's owned phones.

4. **Backfill for ABC**: after fix ships, re-run sync — the write-path will now emit correct `phone_number`, Task 2's guard will attribute those rows to ABC, and `/conversations` will return ~200 real conversations.

### Verification once fixed

Same as Task 2 verification, but stronger — the expected count should reflect real Quo history, not just what happened to slip through the pre-Task-7 extractor:

```bash
# Should return N conversations where N ≈ ABC's Quo conversation count on their 2 owned phones.
# Direct Quo probe indicates N ≥ 200 (100 per phoneNumberId, likely more with pagination).
curl -sS "https://sigcore-production.up.railway.app/api/conversations?limit=200&page=1" \
  -H "x-api-key: $SIGCORE_KEY"

# Every returned row's phone_number should be in {+14254064045, +14256756379}.
```

### Referenced data (for ABC repro)

- ABC's Quo API key: stored on `User.recordingQuoApiKey` in LB DB for userId `96b8da2a-3a59-46f5-b156-cb3e98fd7b81`
- ABC's Quo phoneNumberIds: `PN2Av4NWo1` (→ +14254064045), `PNyi7fw8ye` (→ +14256756379)
- Shared Sigcore workspace: `1bcbb4e0-df1b-481c-83ba-0730df47a720`
- Foreign phone bleeding into ABC's ingest: `+18139212100` (owned by tenant `0361e158-f745-445e-9867-bdd3c33caea0`)
- Post-Task-6 sync run: `2026-09-09T15:28Z` — processed ~30 conversations, 23 correctly orphaned by Task 2 guard, 0 attributed to ABC (all of them had extractor-supplied `phone_number` outside ABC's owned set)
- Post-Task-7 verification (2026-09-10T22:15Z): `/conversations` for ABC still returns `total: 1` (the pre-existing Twilio Call-Connect notification row). Workspace-wide: 6745 conversations total; only **1** has `phone_number ∈ ABC-owned-set`. `phone_number` breakdown of orphan rows: 227 with empty string, 206 with `+18139212100` (foreign tenant), 102 with `+16193938869`, etc. Confirmed: Task 7's credential resolution is doing its job (Sigcore now calls Quo with ABC's key), but Quo returns workspace-wide conversations that reference `phoneNumberId`s outside ABC's owned set. Whatever cascade sets `phone_number` on the DB row is picking a foreign value rather than filtering-out or setting-null.

### Concrete unblock criterion for ABC

After Task 8 ships, verifying:

```bash
curl -sS "https://sigcore-production.up.railway.app/api/conversations?limit=200&page=1" \
  -H "x-api-key: <ABC's sigcore key>"
```

Should return `meta.total ≈ 200+` with every row's `phone_number ∈ {+14254064045, +14256756379}`. Direct Quo probe confirms 100+ real customer conversations per ABC-owned `phoneNumberId` exist to be surfaced.

---

## Recommended sequencing

1. **Task 1 first (P0 security).** Reproduce with a test tenant sharing a phone number, patch the read query, add regression test. Ship as a hotfix.
2. **Task 2 in the same PR or next.** Once Task 1 is fixed, verify whether the `/conversations` "1 of 2720" behavior improves — if the leak was inflating the "1", removing it might drop it to 0 (worse) or reveal a separate filter that's the actual cause. Investigate the filter, remove or expose it.
3. **Task 3 (skipped-reason observability).** Independent, small, high-diagnostic-value.
4. **Task 4 (auth consistency).** Standalone.
5. **Task 5 (GET endpoint).** Nice-to-have.
6. **Task 6 (phone_number extractor null-safety).** Ship alongside or immediately after Task 2 — same failure surface, complementary write-path invariant. Depends on Task 3's `skipReasons` bucket for the new `phone_number_unresolved` reason.
7. **Task 7 (phone_number extractor mis-mapping).** Ships after Task 6 — Task 6 fixes the null case; Task 7 fixes the wrong-value case. This is what actually unblocks ABC (and any future LB tenant on a shared OpenPhone workspace) since the tenant's real conversations remain invisible until the extractor emits per-conversation-correct `phone_number` values scoped to the caller tenant.

## Verification once fixed

Re-run these two probes on ABC's tenant (`d471a324-8489-45f9-88af-2955d7d97db4`):

```bash
# Should return ~2720 conversations (matching conversationsSynced), not 1
curl -sS "https://sigcore-production.up.railway.app/api/conversations?limit=200&page=1" \
  -H "x-api-key: $SIGCORE_KEY"

# Should return ONLY messages where message.tenant_id = d471a324... and message.conversation_id = <the id>
# Currently returns messages tagged tenantId=20013407-... — this is the leak
curl -sS "https://sigcore-production.up.railway.app/api/conversations/<sample-id>/messages" \
  -H "x-api-key: $SIGCORE_KEY"
```

Once Task 1 verifies clean AND Task 2 exposes N conversations, LB can safely resume the ABC unblock at [scripts/_abc-quo-runbook.ts](../Leadbridge-workspace/Leadbridge/scripts/_abc-quo-runbook.ts) Stage 3 with `--commit`. Until then, LB's `ConversationSyncConnection` row for ABC should either stay disabled or be marked with a `blocked_reason` so the live-webhook path doesn't project the leaked data.

## LB-side safety brake (recommended in parallel)

While Sigcore is being fixed, LB should set `ConversationSyncConnection.status = 'DISCONNECTED'` for ABC (row `id = 3ec4d53c-5425-43a4-b7ab-9584bdc3ce86`) so that:
- `hydrateLeadFromQuo` early-returns with `reason: 'no_connection'` for any lead
- The live `/api/webhooks/conversation-sync` handler bails at `handleInboundWebhook` before calling `projectSmsToMessage`

This is a one-line DB update. I've drafted the runbook for it; awaiting Sigcore's fix ETA before deciding whether to run the safety brake or wait it out.

## Referenced data

- ABC Solutions LB userId: `96b8da2a-3a59-46f5-b156-cb3e98fd7b81`
- ABC Sigcore tenant: `d471a324-8489-45f9-88af-2955d7d97db4`
- ABC's SavedAccount used for Flow A: `889684bf-c14a-4432-a79b-8577b9262c91` (Thumbtack SA)
- Sigcore OpenPhone workspace for ABC: `1bcbb4e0-df1b-481c-83ba-0730df47a720`
- Sigcore webhook subscription for ABC: `d93a2c5a-71e1-4b41-ac8f-1e98ddfca8fd`
- The single leaked conversation ID: `565a2536-1930-4447-89aa-cfddc31a28d1`
- Leak-source tenant (the one Sigcore is actually returning data for): `20013407-ecba-4001-a529-42336217e882` (userId `c270d06d-2de6-425f-bdfb-47dd8231c626`)
- Shared phone number: `+14256756379`
