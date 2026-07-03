# Fix — Twilio recording webhook drops recordingUrl for Call Connect legs

**Filed**: 2026-07-03 by LeadBridge
**Scope**: Sigcore only — one-line control-flow fix in `twilio-webhooks.service.ts`
**Effort**: ~5 min code, ~1 min ship, plus optional one-off backfill for historical CC sessions

## Symptom (from LeadBridge side)

`LeadCallConnect.recordingUrl` is `null` for every AI-Receptionist / Call Connect session, so the "Listen to recording" link on the lead detail card never lights up.

Confirmed today on session `0080219a-b90f-48ff-9d63-2a171fee8c18` (workspace `5cdf39a3-bdce-4f67-930a-f17de6095bb7`). Call bridged cleanly, agent leg was 89s, Twilio recording pipeline completed:

- Twilio `RecordingSid`: `RE0aef5633898a49448b25ad485dbc4f7c`
- Twilio recording URL: `https://api.twilio.com/2010-04-01/Accounts/AC…/Recordings/RE0aef5633898a49448b25ad485dbc4f7c` (workspace-Twilio account SID redacted)
- Agent leg CallSid: `CA0d33906d8840f1e513ec6957afebd6a5`

LB pinged Sigcore's session endpoint after the fact — Sigcore also has `recordingUrl: null` on the session, so LB's backfill (`_backfill-cc-recording-urls.js`, which just mirrors Sigcore) has nothing to pull. The recording exists at Twilio; it just never got persisted anywhere downstream.

## Root cause

`backend/src/modules/webhooks/twilio-webhooks.service.ts` `handleRecordingComplete`:

```ts
// 892:
async handleRecordingComplete(payload: TwilioRecordingPayload): Promise<void> {
  this.logger.log(`Processing Twilio recording: CallSid=${payload.CallSid}, RecordingSid=${payload.RecordingSid}`);

  const call = await this.callRepo.findOne({
    where: { providerCallId: payload.CallSid },
    relations: ['conversation'],
  });

  if (!call) {
    this.logger.warn(`Call ${payload.CallSid} not found for recording update`);
    return;                                       // ← early return
  }

  // … mutate + save `call` …

  // 934: Also propagate recordingUrl to any Call Connect session
  if (this.callConnectService) {
    try {
      await this.callConnectService.attachRecordingToSession(
        payload.CallSid,
        payload.RecordingUrl,
      );
    } catch (err: any) { … }
  }
}
```

Call Connect agent/lead legs are **not stored in `communication_calls`** (they're synthesized in the CC state machine), so the lookup on line 895 returns `null`, and the `if (!call)` at line 900 fires the early return on line 902 — never reaching the `attachRecordingToSession` call on line 934 that would have written `CallConnectSession.recordingUrl` and re-emitted `call_connect.ended` to LB.

The sibling `handleCallStatusUpdate` method already handles this correctly (see line 850-858): it forwards to `callConnectService.handleProviderCallStatus` **before** the `communication_calls` lookup, precisely because CC legs aren't in that table. The comment on line 850-851 even says so:

```ts
// Forward to Call Connect state machine first (handles CC session calls
// that are not stored in communication_calls)
```

`handleRecordingComplete` was written with the fallback logic in mind (line 930-933 comment: "Silent no-op if the CallSid isn't a CC leg") — it was just placed on the wrong side of the early return.

Live proof from Loki, service_name=sigcore-api, 2026-07-03 19:21:46Z:

```
19:21:46.092Z Processing Twilio recording: CallSid=CA0d33906d…, RecordingSid=RE0aef56…
19:21:46.164Z Call CA0d33906d… not found for recording update      ← early-returned here
                                                                     never reaches attachRecordingToSession
```

## Fix

Move the `attachRecordingToSession` call to run **before** the `communication_calls` lookup (mirroring the `handleCallStatusUpdate` pattern), or equivalently run it in both branches. Preferred version — do CC first, then the CommunicationCall side effects:

```ts
async handleRecordingComplete(payload: TwilioRecordingPayload): Promise<void> {
  this.logger.log(`Processing Twilio recording: CallSid=${payload.CallSid}, RecordingSid=${payload.RecordingSid}`);

  // Propagate to any Call Connect session that owns this CallSid FIRST. CC agent/lead
  // legs are not stored in communication_calls, so the callRepo lookup below returns
  // null for them — we still need to persist recordingUrl on CallConnectSession and
  // re-emit call_connect.ended to LB so LeadCallConnect.recordingUrl gets set.
  if (this.callConnectService) {
    this.callConnectService
      .attachRecordingToSession(payload.CallSid, payload.RecordingUrl)
      .catch((err) => {
        this.logger.warn(
          `[handleRecordingComplete] attachRecordingToSession failed for CallSid ${payload.CallSid}: ${err.message}`,
        );
      });
  }

  const call = await this.callRepo.findOne({
    where: { providerCallId: payload.CallSid },
    relations: ['conversation'],
  });

  if (!call) {
    this.logger.warn(`Call ${payload.CallSid} not found in communication_calls — may be a Call Connect leg`);
    return;
  }

  // …unchanged from here…
}
```

Two small niceties bundled with the move:

1. Fire-and-forget (`.catch`) matches the pattern in `handleCallStatusUpdate` line 853-857 — a slow CC write shouldn't stall the Twilio webhook ack.
2. Downgrade the `warn` log message on line 901 to match line 865 ("may be a Call Connect leg"), so ops doesn't see false alarms for every CC recording.

## Verification after ship

1. Fire a test AI-Receptionist call (any of the workspaces provisioned to LB — Spotless Homes Tampa `5cdf39a3-…` reproduces reliably), let it end.
2. Wait ~5s after `RecordingStatus=completed` in Twilio.
3. Query Loki `{service_name="sigcore-api"} |= "[attachRecording]"` — should see `Session <id> recordingUrl set from CallSid <CA…>`.
4. `GET /api/internal/call-connect/sessions/<id>` — `recordingUrl` should be populated.
5. On LB side: within seconds, `LeadCallConnect.recordingUrl` for that session should also be non-null (LB's webhook handler is idempotent on repeated `call_connect.ended` and writes `recordingUrl` when present).

## Historical backfill — executed 2026-07-03

Ran `backend/src/scripts/backfill-cc-recording-urls.ts` (npm script `backfill:cc-recordings`) against prod immediately after the fix shipped. The script iterates `CallConnectSession` rows where `recordingUrl IS NULL AND status = 'ENDED' AND agentCallSid IS NOT NULL`, fetches the recording from Twilio via `client.recordings.list({ callSid })[0]`, and calls `attachRecordingToSession` (same public method the live path now uses) — which writes the URL and re-emits `call_connect.ended` to LB.

Result:

- **555** candidates
- **115** recordings attached (still in Twilio retention)
- **440** aged out of Twilio (nothing we can do)
- **0** errors, no LB-side fallout

LB side saw 49 rows populated — the other 66 belong to non-LB tenants and LB's handler silently skipped them as unowned sessions (see LB `call-connect.service.ts:1135-1141`).

Re-running the script is idempotent — `attachRecordingToSession` no-ops when the session already has a `recordingUrl` (see `call-connect.service.ts:1284-1289`).

## Related

- The already-shipped `attachRecordingToSession` method (call-connect.service.ts line 1274) — no change needed; it does the right thing, just wasn't being called for CC legs.
- LB's `scripts/_backfill-cc-recording-urls.js` — pulls `recordingUrl` from Sigcore for LB sessions where it's null but Sigcore has it. After this fix + a Sigcore backfill run, LB can trigger this to close the loop.
