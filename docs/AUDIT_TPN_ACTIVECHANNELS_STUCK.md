# Audit request: `TenantPhoneNumber.metadata.activeChannels` is frozen at purchase-time; no post-purchase update path

**Filed by:** LeadBridge team (2026-08-12)
**Severity:** Customer-impacting (silent voice-channel disable on ≥15 leads over 2+ weeks for one tenant so far — likely affects others)
**Root-cause code:** [`backend/src/common/util/tpn-channel.ts`](../backend/src/common/util/tpn-channel.ts) reads `metadata.activeChannels` as source of truth; [`backend/src/modules/tenants/phone-number-provisioning.service.ts:459-482`](../backend/src/modules/tenants/phone-number-provisioning.service.ts#L459) writes it once at purchase; no endpoint updates it after.

---

## Symptom

LB fires `POST /api/internal/call-connect/start` for Globus Service leads. Sigcore:

1. Accepts the request, creates a session, responds with `sessionId + status=CREATED`
2. Sends the `[TT] New lead: ...` SMS to the dispatcher's phone number ✅
3. Sends the intro SMS to the customer ✅
4. **Never places the voice call** — no `[agent-twiml-body]` log line, no Twilio voice interaction
5. Session sits at `status=CREATED` indefinitely (no terminal webhook ever fires back to LB)

Contrast with a working tenant (Spotless Homes, workspace `1bcbb4e0`), where the same flow produces `[agent-twiml-body] session=... body=<?xml ...<Response><Gather...` within ~2s of session creation and the session advances through `AGENT_ANSWERED → BRIDGED → ENDED`.

## Root cause

`tpnSupportsChannel(tpn, 'voice')` in [`common/util/tpn-channel.ts:39-48`](../backend/src/common/util/tpn-channel.ts#L39-L48) returns `false` for Globus's TPN row because `metadata.activeChannels = ['sms']`, not `['sms','voice']`. The voice-dial guard at [`calls.controller.ts:378-386`](../backend/src/modules/communication/calls.controller.ts#L378-L386) rejects with the "does not support the voice channel" `BadRequestException`.

The underlying Twilio number ITSELF supports voice — `capabilities:['sms','voice','mms']`. It's purely that Sigcore's `metadata.activeChannels` string was captured wrong at purchase time (`channel:'sms'` in the DTO, defaulting to SMS-only).

## Reproduction

LB Loki, service `leadbridge-api`, 2026-08-05 through 2026-08-12:

```logql
{service_name="leadbridge-api"} |~ "PAUSE active_call_connect" |~ "10d6d839-39ec-44e1-bcfe-01ba2f06db48"
```

15 distinct `leadId` values, `LeadCallConnect.status=CREATED`, `lastEventAt` matching the original `[startSession]` timestamp, no state transitions. Oldest: 2026-07-28.

Sigcore-api trace for any of those leads shows the same pattern (`[startSession] Created session=...`, SMS sends, then silence).

## The gap in Sigcore

**No post-purchase update path for `metadata.activeChannels`.** [`tenants.controller.ts`](../backend/src/modules/tenants/tenants.controller.ts) exposes:

- `@Post(':id/phone-numbers/purchase')` — accepts `channel` in DTO, freezes it at purchase
- `@Post(':id/phone-numbers/:allocationId/default')` — set default
- `@Delete(':id/phone-numbers/:allocationId')` — release
- `@Patch('phone-numbers/:phoneNumber/reallocate')` — re-home to different tenant
- `@Patch('phone-numbers/:phoneNumber/call-forwarding')` — update forwarding
- **No PATCH for `metadata.activeChannels` or `metadata.requestedChannel`**

The DELETE + repurchase workaround (documented in the LB memory) is a real workaround, but it's a *phone-number swap in disguise* — the tenant loses their existing number and everything referencing it. Not acceptable for live customers with SMS history.

## Requested actions

### 1. Immediate (unblock Globus)

Run this SQL on Sigcore prod DB. Effective the moment the row is updated — `tpnSupportsChannel` is a pure read, no cache to invalidate:

```sql
UPDATE tenant_phone_numbers
SET metadata = jsonb_set(
  jsonb_set(
    COALESCE(metadata, '{}'::jsonb),
    '{activeChannels}',
    '["sms","voice"]'::jsonb,
    true
  ),
  '{requestedChannel}',
  '"both"'::jsonb,
  true
)
WHERE tenant_id = '<globus-sigcore-tenant-id>'
  AND (metadata->>'activeChannels' IS NULL
       OR metadata->'activeChannels' = '["sms"]'::jsonb);
```

(Sigcore ops: please substitute the Globus tenant id — LB knows it as `10d6d839-39ec-44e1-bcfe-01ba2f06db48` but the Sigcore-side tenant id may differ. The workspace is `1bcbb4e0-df1b-481c-83ba-0730df47a720`, business is `bd6a40cc-e763-4a24-afd8-8b1ddafd980a`.)

**Verify:**

```sql
SELECT phone_number, metadata->'activeChannels' AS active, metadata->'requestedChannel' AS requested
FROM tenant_phone_numbers
WHERE tenant_id = '<globus-sigcore-tenant-id>';
```

Then LB can trigger a new call-connect on any Globus lead as an end-to-end smoke test.

### 2. Audit sweep (find other affected tenants)

Same schema — check for tenants whose numbers have SMS-only metadata but Twilio capabilities include voice:

```sql
SELECT tenant_id, phone_number, metadata->'activeChannels', metadata->'requestedChannel'
FROM tenant_phone_numbers
WHERE status = 'active'
  AND (metadata->>'activeChannels' IS NULL
       OR metadata->'activeChannels' = '["sms"]'::jsonb)
  AND (metadata->'capabilities'->>'voice' = 'true'
       OR metadata->'capabilities' ? 'voice');
```

Any tenant on this list has the same silent-voice-disable bug and needs the same UPDATE.

### 3. Fix the class of bug (short PR)

Add a PATCH endpoint so this never requires ops SQL again:

```
PATCH /api/tenants/:id/phone-numbers/:allocationId/channels
Body: { "channel": "both" | "sms" | "voice" }
```

Implementation: validates Twilio `capabilities` allows the requested channel (guard against enabling voice on an SMS-only underlying Twilio number), updates `metadata.activeChannels` + `metadata.requestedChannel`, re-runs `ensureOutboundReady` (idempotent — see [`phone-number-provisioning.service.ts:180`](../backend/src/modules/tenants/phone-number-provisioning.service.ts#L180)), returns the updated allocation. Small PR (~50 lines).

### 4. Root cause hardening (design conversation)

The deeper failure: when `/call-connect/start` gets called on a business whose number lacks the voice channel, Sigcore accepts the request, creates a session at `CREATED`, sends SMS notifications, and then *silently drops the voice leg*. There's no session transition to `SKIPPED` / `FAILED` and no error surfaced to the caller. Consumers (LB) can't tell success from silent-drop without polling.

Recommended: `/call-connect/start` should either

- (a) reject synchronously (400) when the tenant's default outbound TPN doesn't support voice — LB records `SKIPPED` immediately, follow-up sequence proceeds without the pause, OR
- (b) accept but immediately transition the session to `FAILED` + fire the terminal webhook — LB's existing state-machine handles it

Currently the session is in a lifecycle limbo. LB shipped a symptom-side patch (`CALL_CONNECT_MAX_ACTIVE_AGE_MINUTES=60` in [FollowUpGate](https://github.com/Geos-LLC/geos-leadbridge/blob/main/src/follow-up-engine/follow-up-gate.service.ts)) that treats sessions stuck > 60 min as orphaned, but the correct fix is on the Sigcore side.

## LB-side context

- LB memory: [`reference_sigcore_call_connect_orphan_sessions.md`](../../../../.claude/projects/c--Users-HP-Desktop-Projects-Active-Running-Leadbridge-workspace-Leadbridge/memory/reference_sigcore_call_connect_orphan_sessions.md) — full findings
- LB memory: [`reference_sigcore_phone_purchase_channel.md`](../../../../.claude/projects/c--Users-HP-Desktop-Projects-Active-Running-Leadbridge-workspace-Leadbridge/memory/reference_sigcore_phone_purchase_channel.md) — the original `channel:'sms'` default trap that landed the row wrong in the first place
- LB canary tool: `scripts/_monitor-gate-canary.ts` — surfaces this class of bug within minutes of a new gate deploy
