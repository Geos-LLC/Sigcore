# Investigation — Call Connect whisper fails on Yelp leads (cross-tenant shared phone)

**Filed**: 2026-06-01 by LeadBridge
**Severity**: P1 — manager cannot bridge to live customer; AGENT_FIRST whisper-gather silently breaks
**Scope**: Sigcore (LeadBridge side verified clean)

## TL;DR

When LeadBridge fires Call Connect for a **Yelp** lead on Spotless Homes Jacksonville, the manager's phone rings, manager picks up, **hears no whisper**, doesn't press a digit, gather times out, session ends `FAILED: Agent answered but did not accept`. A Thumbtack lead on the **same owner, same bot number, same agent number, same day** completes the whisper, gather digits=1, and bridges in ~135 ms.

The only variable that changes is the Sigcore tenant the session is created in. LB sends the correct fully-substituted `agentWhisperMessage` in the `/call-connect/start` payload — Sigcore renders broken/empty agent TwiML anyway.

This is the **call-connect analogue of the 2026-05-11 Yelp JAX cross-tenant SMS bug** that was fixed via PPA-based caller auth. Call Connect was not refactored the same way.

## Reproduction data

Real production session captured in Loki on 2026-06-01:

| Field | Value |
|---|---|
| Failed Sigcore session | `e4128afd-2c0a-405f-aeb0-849fef21c892` |
| Failed business (LB savedAccountId) | `b538ae14-215e-4c59-af96-9200fc132e1c` (Spotless Yelp JAX) |
| Sigcore workspace | `1bcbb4e0-df1b-481c-83ba-0730df47a720` |
| Bot phone | `+19045778584` (TT-JAX-owned, shared via PPA `4c5365f4-668d-4d90-bc6e-a98bd2b45051` — see 2026-05-11 amendment) |
| Lead | `d8f2f8c9-39ca-47ae-ac21-***0879` (Ed R., Regular home cleaning) |
| Mode | `AGENT_FIRST` |

### Side-by-side comparison — same day, same phone, same agent

| Tenant | Lead | TwiML latency | Outcome |
|---|---|---|---|
| `99a3ac1a` Spotless **TT** JAX | George Drozak (TT) | 133 ms | gather digits=1 → BRIDGED |
| `b538ae14` Spotless **Yelp** JAX | Ed R. (Yelp) | **512 ms** | no gather → "did not accept" → FAILED |

Both used bot `+19045778584` and agent `***00`. Only the Sigcore tenant differs.

## LeadBridge-side payload (verified correct)

Captured in `sigcore-api` log at `2026-06-01T19:06:42Z` (`[Request Body]` on `/api/internal/call-connect/start`):

```json
{
  "businessId": "b538ae14-215e-4c59-af96-9200fc132e1c",
  "leadId": "d8f2f8c9-39ca-47ae-ac21-***0879",
  "leadPhoneE164": "***29",
  "leadSummary": "Ed R. — Regular home cleaning — ",
  "agentWhisperMessage": "You have a new lead for Regular home cleaning. Customer name: Ed R.. Press any key to connect.",
  "leadVoicemailMessage": "Hi Ed R., this is Spotless Homes. We tried to reach you about your Regular home cleaning request. Please call us back...",
  "agentHint": "+1***00",
  "fromNumberHint": "+19045778584",
  "source": "leadbridge"
}
```

`agentWhisperMessage` is fully substituted and non-empty. **The bug is downstream of this payload.**

## Sigcore-side timeline (from Loki, `service_name="sigcore-api"`)

```
19:06:42  [Request Body] {…agentWhisperMessage:"You have a new lead…Press any key to connect."}
19:06:43  [startSession] Created session=e4128afd workspace=1bcbb4e0 business=b538ae14
             bot=***84 agent=***00 lead=d8f2f8c9 mode=AGENT_FIRST recordAgentLeg=false
19:06:44  AGENT_FIRST: calling agent ***00 for session e4128afd
19:06:44  Call Connect status: session=e4128afd, AGENT leg, status=ringing
19:06:44  [Request] POST /api/webhooks/twilio/voice/agent?sessionId=e4128afd      ← Twilio asks for agent TwiML
19:06:44  Call Connect agent TwiML: sessionId=e4128afd
19:06:44  Call Connect status: session=e4128afd, AGENT leg, status=in-progress   ← agent picked up
19:06:45  [Response] POST /api/webhooks/twilio/voice/agent - 200 (512ms)
19:07:10  Call Connect status: session=e4128afd, AGENT leg, status=completed
19:07:10  Session e4128afd: agent answered but did not accept (hung up or gather timeout)
19:07:10  Session e4128afd FAILED: Agent answered but did not accept
```

26 seconds elapsed between "agent answered" and "did not accept." Agent heard something insufficient to prompt a keypress.

Contrast with the working TT session `88dda07c` (same agent, same bot, ~2 hours earlier):

```
17:04:28  voice/agent TwiML 200 (133ms)
17:04:37  Call Connect gather: sessionId=88dda07c, digits=1   ← agent pressed key
17:04:40  Bridged to lead
```

133 ms vs 512 ms TwiML response is a strong signal the Yelp path is hitting a slow fallback / cross-tenant lookup that the TT path avoids.

## Working theory

The agent TwiML renderer for `POST /api/webhooks/twilio/voice/agent` reads the whisper text from a workspace-scoped `call_connect_setting` row (keyed by the session's `business_id` / workspace), **not** from a per-session field carrying the `agentWhisperMessage` LB sent in `/call-connect/start`.

- For `99a3ac1a` (TT-JAX), the workspace row exists and has a populated whisper because the owner explicitly configured Call Connect for that LB account.
- For `b538ae14` (Yelp-JAX), the workspace row is missing or has `agent_whisper_message = null/''`, so the rendered TwiML contains an empty `<Say>` and either no `<Gather>` or a `<Gather>` with no audible prompt.
- The 512 ms latency on the Yelp path matches a slow-path/fallback lookup (e.g., a cross-tenant scan, a cache miss, or a deferred default-resolution branch).

This is the SAME class of bug as the 2026-05-11 Yelp JAX outbound SMS failure: identity of the *caller* (workspace/tenant initiating the action) drifted from identity of the *owner of the phone number*. SMS was fixed by PPA-based caller auth; Call Connect was not.

## Investigation steps for Sigcore

1. **Confirm the workspace setting hypothesis (5 min, definitive)**
   - Query the Sigcore DB:
     ```sql
     SELECT business_id, enabled, agent_whisper_message, agent_accept_digits,
            mode, bot_number_e164, agent_phone_e164, updated_at
     FROM call_connect_setting
     WHERE business_id IN (
       'b538ae14-215e-4c59-af96-9200fc132e1c',  -- Spotless Yelp JAX (broken)
       '99a3ac1a-6ace-49cd-abc9-52e5d1f6714c'   -- Spotless TT JAX (works)
     );
     ```
   - Hypothesis says: Yelp row is null/missing/empty whisper; TT row is populated.

2. **Capture the actual agent TwiML body for session `e4128afd`**
   - Either re-fire a test session against `b538ae14` and log the TwiML response body, or add a one-shot log line to the `/api/webhooks/twilio/voice/agent` handler:
     ```ts
     this.logger.log(`[agent-twiml] session=${sessionId} body=${twiml.toString()}`);
     ```
   - Expect to see either an empty `<Say>` or a `<Gather>` without nested prompt.

3. **Trace the whisper resolution path in the agent-TwiML controller**
   - Likely file: `backend/src/modules/call-connect/*` (or wherever `voice/agent` is handled).
   - Check the order of precedence the renderer uses:
     - Per-session field on `lead_connect_session` (e.g., `agent_whisper_message`)?
     - Workspace `call_connect_setting.agent_whisper_message`?
     - Hardcoded default?
   - The LB-sent per-session value should win. If it doesn't, that's the bug.

4. **Check whether the per-session agentWhisperMessage is even persisted at session creation**
   - In the `/api/internal/call-connect/start` handler, confirm `agentWhisperMessage` from the payload is written to a column on `lead_connect_session` (or equivalent). If it's accepted but never persisted, that's the root cause.

5. **Confirm the cross-tenant aspect**
   - Same query as (1) for several other Yelp-JAX-style accounts where the phone is owned by a sibling TT tenant. Repro should be 100% if the workspace row is missing.

## Expected fix paths

In order of preference:

**Fix A (preferred) — Sigcore agent-TwiML renderer prefers per-session whisper**
Mirror the per-session `leadVoicemailMessage` behavior that already exists on `/start` (LB notes in [call-connect.service.ts:741-746](https://…) that Sigcore "uses this per-session value, overriding the workspace template"). Do the same for `agentWhisperMessage`: persist it on the session row at `/start`, and have the agent-TwiML renderer read from the session first, falling back to workspace only if null. This makes Call Connect tenant-agnostic for the whisper — exactly what cross-tenant shared-phone flows need.

**Fix B — Auto-backfill workspace setting from session**
At `/start`, if the workspace `call_connect_setting.agent_whisper_message` is null/empty but the payload includes one, upsert the workspace row from the payload. Less clean than Fix A (mutates workspace settings as a side effect) but solves the live incident without renderer changes.

**Fix C (LB-side workaround, NOT a real fix)**
LB calls `pushSettingsToSigcore` again any time it pushes a CC start for a tenant that has no settings. Wasteful and doesn't address the design gap. Document only — don't ship.

## Verification

After fix, re-fire a Call Connect for a Yelp lead on `b538ae14`:

1. LB logs show `[triggerForLead] Session started` with `status=CREATED`.
2. Sigcore agent TwiML response < 200 ms (same as TT path).
3. Manager hears the substituted whisper text exactly as LB sent it.
4. Manager presses any digit → `Call Connect gather: digits=<x>` log line appears.
5. Session reaches `BRIDGED`.

Test on staging first using the Test Call button in LB → Spotless Yelp JAX → Instant Call Connect (this is `triggerTestCall` which already sets `recordAgentLeg: true` — listen back to the recording to verify the whisper plays).

## Pointers

- LB side (no changes expected): `c:\Users\HP\Desktop\Projects\Active\Development\geos-leadbridge\src\call-connect\call-connect.service.ts` — `triggerForLead` (line 610), payload at lines 758-770.
- Sigcore CallConnect notes: [TENANT_ISOLATION_FIX.md](../TENANT_ISOLATION_FIX.md), [MULTI_TENNAT_FIX.md](../MULTI_TENNAT_FIX.md), [API_FOR_INSTANT_CALL_LEADBRIDGE.md](../API_FOR_INSTANT_CALL_LEADBRIDGE.md).
- Cross-tenant shared TPN context (SMS analogue, already fixed): Spotless +19045778584 TPN row `2d6269bc-6258-421e-a60c-5c949bb0d0dc`, PPA `4c5365f4-668d-4d90-bc6e-a98bd2b45051`.

## Out of scope

- The 2026-05-11 SMS cross-tenant PPA fix. That fix already works; do not regress it.
- Yelp customer-phone extraction in LB. Phone arrival is fine — the call did ring the customer-leg-equivalent agent number successfully.
- LB-side whisper substitution. Verified correct.

## Resolution — Sigcore-side findings (2026-06-01)

The plan's working theory was that the agent-TwiML renderer reads from a workspace-scoped `call_connect_settings` row only. **Code inspection contradicts that hypothesis** — Fix A was already implemented in Feb 2026 (commit `cc05acb8c`):

- [call-connect.service.ts:242](backend/src/modules/webhooks/call-connect.service.ts#L242) — `startSession` persists `dto.agentWhisperMessage` (and `leadGreetingMessage` / `leadVoicemailMessage`) on the `call_connect_sessions` row.
- [call-connect.service.ts:339-343](backend/src/modules/webhooks/call-connect.service.ts#L339-L343) — `handleAgentTwiml` reads `session.agentWhisperMessage` first, falls back to `settings.agentWhisperMessage`, then to a built-in default.

So the renderer is *already* tenant-agnostic for the whisper. If LB's payload contains a fully substituted `agentWhisperMessage`, the workspace settings row never enters the picture for that field. The Yelp/JAX failure therefore is not the bug Fix A is meant to address — but the plan filed without that confirmation.

### What this PR delivers

1. **Diagnostic logging** so the next occurrence is unambiguously root-caused from Loki without re-deriving the code path:
   - `[startSession] Created … perSessionWhisper=yes|no perSessionGreeting=yes|no perSessionVoicemail=yes|no` — confirms LB's per-session fields were received and persisted (or not).
   - `[agent-twiml] session=… business=… settingsFound=true|false whisperSource=session|settings|default whisperLen=<n>` — names the exact source the rendered TwiML used. If `whisperSource=session` and `whisperLen>0` on the failing Yelp call, the whisper IS being rendered correctly and the failure is downstream (Twilio TTS, audio path, agent UX). If `whisperSource=default`, LB's per-session value never landed and we look upstream at `/start` ingestion.

2. **5 regression tests** in `call-connect.service.spec.ts` covering all four whisper-resolution paths plus the missing-session case, so Fix A's invariant ("per-session wins, settings fallback, default last") cannot regress silently.

### What this PR does NOT do

- It does not change the resolution order — Fix A's invariant was already correct.
- It does not change settings lookup keying. `handleAgentTwiml` still queries `settings WHERE business_id = session.business_id` (where `session.business_id = workspaceId`, line 236). For the Yelp/JAX scenario, the per-session value supersedes settings entirely, so the keying mismatch (if any) is moot for the whisper.

### Verifying on the next failure

After deploy, re-fire Call Connect for Spotless Yelp JAX. The two new log lines tell you immediately:

- If `perSessionWhisper=yes` at `/start` and `whisperSource=session whisperLen>50` at TwiML render → the TwiML carrying the correct whisper is reaching Twilio. Investigate Twilio Voice Insights for that AGENT call SID (latency, TTS region, codec) or agent-handset behavior.
- If `perSessionWhisper=yes` at `/start` but `whisperSource=settings` or `whisperSource=default` at render → the session row's whisper was lost between writes and reads (possible: stale read, ORM hydration issue, second `save()` clobbering the field). This would be a real Fix A regression and we'd need to follow up.
- If `perSessionWhisper=no` at `/start` → the DTO field didn't bind (validator/transformer issue, payload encoding) — investigate the request body and DTO whitelist behavior.

Backend tests: `33 suites passed, 545 tests passed` after these changes.
