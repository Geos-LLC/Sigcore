# TASK — LEADBRIDGE: Instant Call Connect Integration

> **Context:** Sigcore has fully implemented the Call Connect orchestration layer.
> This document is the LeadBridge-side implementation spec — what LeadBridge needs to
> build to configure, trigger, receive events from, and display results of Sigcore's
> Call Connect.

---

## Goal

When a new lead arrives in LeadBridge, automatically trigger an outbound voice bridge
via Sigcore: call the agent first, let them hear a whisper summary, press 1 to accept,
then bridge the lead in. Show the result in the lead activity feed.

---

## What Sigcore Already Provides (Do NOT re-build)

| Feature | Details |
|---|---|
| Call orchestration (AGENT_FIRST / PARALLEL) | Sigcore manages Twilio |
| Agent whisper + digit-accept flow | Fully implemented |
| AMD voicemail detection + auto-drop | Configured via settings |
| Session state machine | CREATED → CALLING_AGENT → … → BRIDGED / ENDED / FAILED |
| Outbound webhooks to LeadBridge | HMAC-signed POST to your endpoint |
| Idempotency | Same `businessId + leadId` never creates a duplicate session |
| Settings CRUD | One-time setup per business via API |

---

## Sigcore API Reference

### Base URL
Configured per deployment — store as `SIGCORE_API_URL` env var.

### Authentication
All requests require:
```
X-API-Key: <workspace_api_key>
```
The workspace API key is issued by Sigcore per business (tenant).

---

### 1. Configure Settings (one-time per business)

```
POST /api/internal/call-connect/settings
X-API-Key: <workspace_api_key>
Content-Type: application/json

{
  "enabled": true,
  "mode": "AGENT_FIRST",
  "botNumberE164": "+19045778584",
  "agentPhoneE164": "+12483462681",
  "maxAgentAttempts": 2,
  "leadVoicemailEnabled": true,
  "leadVoicemailMessage": "Hi, we tried reaching you about your inquiry. Please call us back.",
  "agentWhisperMessage": "New lead: {summary}. Press 1 to connect.",
  "leadGreetingMessage": "Please hold while we connect you."
}
```

**Response:** the saved settings object.

**Available fields:**

| Field | Type | Default | Notes |
|---|---|---|---|
| `enabled` | boolean | false | Master on/off switch |
| `mode` | `AGENT_FIRST` \| `PARALLEL` | `AGENT_FIRST` | AGENT_FIRST = call agent first, PARALLEL = both simultaneously |
| `botNumberE164` | string | — | Shared bot number used as caller ID (required) |
| `agentPhoneE164` | string | — | Agent's phone number (required for MVP) |
| `maxAgentAttempts` | int | 2 | How many times to retry calling the agent |
| `agentAcceptDigits` | string | `"1"` | Digit agent presses to accept |
| `agentWhisperMessage` | string | built-in | Supports `{summary}` and `{digit}` placeholders |
| `leadGreetingMessage` | string | built-in | Played to lead while waiting |
| `leadVoicemailEnabled` | boolean | false | Auto-drop voicemail if lead doesn't answer |
| `leadVoicemailMessage` | string | built-in | TTS text for voicemail |
| `leadVoicemailRecordingUrl` | string | — | Pre-recorded MP3/WAV URL (takes priority over TTS) |
| `quietHours` | `{ timezone, start, end }` | — | e.g. `{ "timezone": "America/New_York", "start": "22:00", "end": "08:00" }` |

---

### 2. Register Webhook Subscription (one-time per business)

LeadBridge must register its webhook endpoint so Sigcore can push call-connect events.

```
POST /api/webhooks/subscriptions
X-API-Key: <workspace_api_key>
Content-Type: application/json

{
  "name": "LeadBridge Call Connect",
  "webhookUrl": "https://leadbridge.example.com/webhooks/sigcore/call-connect",
  "secret": "<random_hmac_secret>",
  "events": [
    "call_connect.session.created",
    "call_connect.agent.ringing",
    "call_connect.agent.accepted",
    "call_connect.lead.ringing",
    "call_connect.bridged",
    "call_connect.voicemail_drop",
    "call_connect.ended",
    "call_connect.failed"
  ]
}
```

Store the `secret` in your DB — you will use it to verify incoming signatures.

---

### 3. Trigger Call Connect on New Lead

```
POST /api/internal/call-connect/start
X-API-Key: <workspace_api_key>
Content-Type: application/json

{
  "businessId": "<workspace_id>",
  "leadId": "lb_lead_abc123",
  "leadPhoneE164": "+15559876543",
  "leadSummary": "John Smith — Plumbing repair — Brooklyn, NY",
  "source": "thumbtack"
}
```

**Response:**
```json
{ "sessionId": "uuid", "status": "CREATED" }
```

**Idempotent:** calling `/start` again with the same `businessId + leadId` returns the
existing session rather than creating a new one.

**Error responses:**
| HTTP | Reason |
|---|---|
| 422 | Call Connect disabled for this business |
| 422 | Within quiet hours |
| 422 | Bot number or agent phone not configured |

---

### 4. Cancel a Session (optional)

```
POST /api/internal/call-connect/cancel
X-API-Key: <workspace_api_key>
Content-Type: application/json

{ "sessionId": "uuid" }
```

Use this when the lead is already engaged via another channel before the bridge connects.

---

### 5. Get Session Status (polling fallback)

```
GET /api/internal/call-connect/sessions/:sessionId
X-API-Key: <workspace_api_key>
```

Returns the full session object including `status`, `attempt`, `timeline`, and
`failureReason`.

---

## Events Sigcore Sends to LeadBridge

Sigcore will `POST` to your registered `webhookUrl` for each state transition.

### Signature Verification

Every request includes the header:
```
X-Callio-Signature: <hmac_sha256_hex>
```

Verify with:
```js
const expected = crypto
  .createHmac('sha256', secret)
  .update(rawBodyBuffer)
  .digest('hex');

if (expected !== req.headers['x-callio-signature']) {
  return res.status(401).end();
}
```

### Event Payload Shape

```json
{
  "event": "call_connect.bridged",
  "timestamp": "2026-02-19T10:00:00Z",
  "data": {
    "sessionId": "uuid",
    "leadId": "lb_lead_abc123",
    "businessId": "workspace_id",
    "status": "BRIDGED",
    "mode": "AGENT_FIRST",
    "agentPhone": "+12483462681",
    "leadPhone": "+15559876543",
    "attempt": 1,
    "updatedAt": "2026-02-19T10:00:05Z"
  }
}
```

For `call_connect.failed`, the `data` object additionally includes:
```json
{ "reason": "Max agent attempts reached: Agent no-answer" }
```

For `call_connect.voicemail_drop`:
```json
{ "mode": "tts" }
```

### Event Sequence (happy path)

```
session.created → agent.ringing → agent.accepted → lead.ringing → bridged → ended
```

### Event Sequence (voicemail drop)

```
session.created → agent.ringing → agent.accepted → lead.ringing → voicemail_drop → ended
```

### Event Sequence (missed call)

```
session.created → agent.ringing → failed (max attempts)
  OR
session.created → agent.ringing → agent.accepted → lead.ringing → ended (lead_no_answer)
```

---

## LeadBridge DB Changes

### Table: `automation_settings`

| Column | Type | Default | Notes |
|---|---|---|---|
| `business_id` | varchar PK | — | FK to businesses |
| `call_connect_enabled` | boolean | false | |
| `call_connect_mode` | enum | `AGENT_FIRST` | |
| `agent_strategy` | enum | `OWNER` | OWNER / ROUND_ROBIN / ON_DUTY |
| `quiet_hours_timezone` | varchar | null | |
| `quiet_hours_start` | varchar | null | "HH:MM" |
| `quiet_hours_end` | varchar | null | "HH:MM" |
| `sigcore_api_key` | varchar | null | workspace API key from Sigcore |
| `sigcore_webhook_secret` | varchar | null | secret registered with Sigcore |
| `created_at` | timestamp | | |
| `updated_at` | timestamp | | |

### Table: `lead_call_connect`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `lead_id` | varchar | FK to leads |
| `business_id` | varchar | |
| `sigcore_session_id` | uuid | returned by `/start` |
| `status` | varchar | mirrors Sigcore status |
| `attempt` | int | |
| `failure_reason` | varchar | null |
| `recording_url` | varchar | null — future |
| `last_event_at` | timestamp | |
| `timeline` | jsonb | append-only events array |
| `created_at` | timestamp | |
| `updated_at` | timestamp | |

---

## Settings UI

Location: **Automation** section in business settings.

### Component: Instant Call Connect

```
┌─────────────────────────────────────────────────┐
│  Instant Call Connect                    [ ON ]  │
│                                                  │
│  Mode                                            │
│  ● Agent first (recommended)                     │
│    Call agent first — they hear a lead summary   │
│    and press 1 to connect the lead.              │
│  ○ Parallel (fastest)                            │
│    Call agent and lead simultaneously.           │
│                                                  │
│  Agent routing                                   │
│  [ Owner ▾ ]                                    │
│                                                  │
│  Quiet hours  □ Enable                           │
│  Timezone [ America/New_York ▾ ]                │
│  From [ 22:00 ] To [ 08:00 ]                    │
│                                                  │
│  ─────────────────────────────────────────────  │
│  ⚠ Starter plan: calls use a shared bot number. │
│  Upgrade to Pro+ for your own business number.  │
└─────────────────────────────────────────────────┘
```

On save → call Sigcore `POST /api/internal/call-connect/settings` with mapped values
(do not expose voicemail settings in this UI — those are configured by Sigcore admin).

---

## Trigger Logic (Backend)

On new lead creation (or first message received from Thumbtack):

```js
async function maybeStartCallConnect(lead, business) {
  const settings = await getAutomationSettings(business.id);

  if (!settings.call_connect_enabled) return;

  // Cooldown: don't re-trigger if session exists from last 30 min
  const recent = await db.leadCallConnect.findOne({
    where: {
      lead_id: lead.id,
      created_at: { $gte: subMinutes(new Date(), 30) }
    }
  });
  if (recent) return;

  let resp;
  try {
    resp = await sigcoreClient.post('/api/internal/call-connect/start', {
      businessId: business.sigcore_workspace_id,
      leadId: lead.id,
      leadPhoneE164: lead.phone_e164,
      leadSummary: buildSummary(lead),   // "John Smith — Plumbing — Brooklyn NY"
      source: lead.source,               // "thumbtack"
    }, {
      headers: { 'X-API-Key': settings.sigcore_api_key }
    });
  } catch (err) {
    logger.error('Call Connect start failed', err);
    return;
  }

  await db.leadCallConnect.create({
    lead_id: lead.id,
    business_id: business.id,
    sigcore_session_id: resp.data.sessionId,
    status: resp.data.status,
    timeline: [],
    last_event_at: new Date(),
  });
}
```

---

## Receive Sigcore Events (Webhook Handler)

```js
POST /webhooks/sigcore/call-connect

async function handleSigcoreCallConnectEvent(req, res) {
  // 1. Verify signature
  const sig = req.headers['x-callio-signature'];
  const expected = crypto
    .createHmac('sha256', process.env.SIGCORE_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest('hex');

  if (sig !== expected) return res.status(401).end();

  const { event, timestamp, data } = req.body;

  // 2. Find session record
  const record = await db.leadCallConnect.findOne({
    where: { sigcore_session_id: data.sessionId }
  });
  if (!record) return res.status(200).end(); // unknown session, ignore

  // 3. Update record
  await db.leadCallConnect.update(record.id, {
    status: data.status,
    attempt: data.attempt,
    failure_reason: data.reason ?? null,
    last_event_at: new Date(data.updatedAt),
    timeline: [...(record.timeline || []), { event, timestamp, data }],
  });

  // 4. Append to lead activity feed
  await db.leadActivity.create({
    lead_id: record.lead_id,
    type: 'call_connect',
    event,
    payload: data,
    created_at: new Date(timestamp),
  });

  res.status(200).end();
}
```

> **Important:** Sigcore looks up the webhook subscription by `businessId`.
> Make sure each business has its own subscription registered with their own
> `sigcore_api_key` and a unique `webhookUrl` (or include `businessId` as a query param).

---

## Lead Activity UI Card

On the lead details page, show a "Call Connect" card that updates in real time (or on refresh):

```
┌──────────────────────────────────────────────────┐
│  📞 Call Connect                                 │
│                                                  │
│  Status   BRIDGED                                │
│  Attempt  1                                      │
│  Agent    +1 (248) 346-2681                      │
│                                                  │
│  Timeline                                        │
│  ✓  6:55:57 PM  Session created                  │
│  ✓  6:56:13 PM  Agent ringing                   │
│  ✓  6:56:20 PM  Agent accepted                  │
│  ✓  6:56:21 PM  Lead ringing                    │
│  ✓  6:56:28 PM  Bridged ✓                       │
│  ✓  6:57:15 PM  Ended (45s)                     │
└──────────────────────────────────────────────────┘
```

**Status badge mapping:**

| Sigcore status | Badge text | Color |
|---|---|---|
| `CREATED` / `CALLING_AGENT` | Connecting… | blue |
| `AGENT_ANSWERED` / `AGENT_ACCEPTED` | Agent connected | blue |
| `CALLING_LEAD` | Ringing lead… | blue |
| `BRIDGED` | Connected | green |
| `ENDED` | Ended | gray |
| `FAILED` | Missed | red |
| `CANCELED` | Canceled | gray |

---

## Tier Enforcement

For now, **all tiers use the shared bot number** — no LeadBridge-side enforcement needed.
Sigcore uses `botNumberE164` from settings as caller ID for all calls.

Future (Pro+ tier):
- LeadBridge sets `callerIdStrategy: "BUSINESS_NUMBER"` in the settings call
- Sigcore then uses the `businessNumberE164` on file for that business
- Add a UI note: *"Upgrade to Pro+ to use your own business number"*

---

## Setup Checklist (per business onboarding)

- [ ] Sigcore workspace created, API key issued
- [ ] Agent phone number captured from business profile
- [ ] Bot number provisioned in Sigcore (admin task)
- [ ] `POST /api/internal/call-connect/settings` called with `enabled: true`, phone numbers
- [ ] Webhook subscription registered (`POST /api/webhooks/subscriptions`)
- [ ] `sigcore_api_key` and `sigcore_webhook_secret` stored in `automation_settings`
- [ ] `call_connect_enabled: true` set in LeadBridge automation settings

---

## Acceptance Tests

| Scenario | Expected result |
|---|---|
| New lead created, CC enabled | Session created, agent receives call within 5s |
| Agent presses 1 | Lead receives call, both bridged |
| Agent doesn't answer (×2) | `call_connect.failed` event, lead activity shows "Missed" |
| Lead doesn't answer, voicemail ON | `call_connect.voicemail_drop` then `ended` |
| Lead doesn't answer, voicemail OFF | `call_connect.ended` (not failed) |
| `/start` called twice for same lead | Same `sessionId` returned, no duplicate calls |
| Within quiet hours | 422 returned, no session created |
| CC toggled OFF | `/start` returns 422, graceful UI message |
| Invalid HMAC on webhook | 401, record not updated |
