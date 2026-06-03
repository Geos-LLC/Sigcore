# Follow-up — Two more diagnostic logs for CC whisper investigation

**Filed**: 2026-06-03 by LeadBridge
**Parent**: [2026-06-01-cc-whisper-yelp-cross-tenant.md](2026-06-01-cc-whisper-yelp-cross-tenant.md)
**Scope**: Sigcore only — small follow-up to the diagnostic logging shipped in commit `583d40a3`
**Effort**: ~10 minutes

## Why

The diagnostic logs you shipped on 2026-06-01 worked exactly as designed and routed us to bucket `TWILIO_PATH`. Live failure on 2026-06-03 17:54Z, session `8ab925b3-f911-4030-8c8b-140bbca73f1f`, business `f8de064f-…`:

```
[startSession] … perSessionWhisper=yes  perSessionGreeting=yes  perSessionVoicemail=yes
[agent-twiml] session=8ab925b3 business=1bcbb4e0 settingsFound=false whisperSource=session whisperLen=111
[Response] POST /api/webhooks/twilio/voice/agent - 200 (145ms)
Session 8ab925b3 FAILED: Agent answered but did not accept
```

So the per-session whisper IS being rendered. But we can't yet confirm:
- What the rendered TwiML actually said (right text? right `<Gather>` timeout?)
- Which Twilio AGENT call SID this session corresponds to (so we can look it up in Twilio Voice Insights for audio delivery / disconnect cause / codec)

Both are one-line log additions to the same `/api/webhooks/twilio/voice/agent` handler you already touched.

## What to add

### 1. Log the rendered TwiML body

In `backend/src/modules/webhooks/call-connect.service.ts` `handleAgentTwiml`, right after the TwiML object is built and before it's returned, add:

```ts
this.logger.log(
  `[agent-twiml-body] session=${sessionId} body=${twiml.toString()}`
);
```

Goes next to the existing `[agent-twiml]` log line (line ~350 per parent plan). The existing line names the source; this line shows the content. Acceptable to truncate at 1000 chars if TwiML gets long.

### 2. Log the Twilio AGENT CallSid

Wherever Sigcore receives the response from `twilioClient.calls.create({...})` for the AGENT leg in `AGENT_FIRST` mode, log:

```ts
this.logger.log(
  `[agent-call-sid] session=${sessionId} agentCallSid=${call.sid}`
);
```

Likely lives in `startSession` near `AGENT_FIRST: calling agent ***00 for session …` log line (per parent plan timeline). If the Twilio call is created and the SID is available there, log it.

If the CallSid isn't accessible at session creation but arrives later via the `voice/agent` webhook (Twilio's `CallSid` query param), log there instead — either place is fine, we just need it tied to sessionId once.

## What this unlocks

Next failure → triage routine hands us the sessionId → we grep Loki for `agent-call-sid` to get the Twilio CallSid → drop into Twilio Console → play back the recording (LB is enabling `recordAgentLeg=true` on production triggers in parallel) and pull Voice Insights.

If TwiML body shows a correct `<Say>` + `<Gather timeout=X>`:
- Recording silent → Twilio TTS delivery problem (codec, region, packet loss)
- Recording plays whisper → agent hung up because the gather timeout is too short relative to whisper duration → bump `<Gather timeout>` from whatever it is now to something longer (~10–15s after whisper ends)
- Recording plays whisper + agent presses key but Twilio doesn't capture → DTMF detection issue (Twilio side)

If TwiML body shows truncated/empty `<Say>` or no `<Gather>`:
- Means `whisperSource=session whisperLen=111` lied → there's a render-vs-emit gap inside the TwiML builder → that would be a real Sigcore bug

## Tests

The existing 5 regression tests in `call-connect.service.spec.ts` from commit `583d40a3` cover whisper resolution. The two new log lines don't need new tests — they're side-effect-only and can be smoke-checked by re-running one existing test and asserting `logger.log` was called with the expected pattern.

## Out of scope

- Don't change `<Gather>` timeout yet — first capture the body and confirm what it is.
- Don't change the renderer precedence — Fix A is already correct and confirmed.
- Don't add per-session greeting/voicemail body logs — only the whisper is failing.
