TASK — SIGCORE (Call Connect Orchestrator)
Goal

Implement Instant Call Connect in Sigcore as a reusable workflow that can:

accept a “new lead” trigger from LeadBridge

start outbound voice flows using a bot number (and later per-business number)

support two modes: AGENT_FIRST and PARALLEL

bridge agent ↔ lead

persist session state + emit status updates back to LeadBridge

Assumptions

Sigcore already has Twilio voice capability (or a provider adapter).

Sigcore has DB access (Postgres) and a webhook router.

Deliverables

DB schema + migrations

REST API endpoints (internal + webhooks)

Twilio (or provider) call orchestration for both modes

Status callbacks + idempotency

Event emission back to LeadBridge

Minimal test plan + local dev instructions

1) Data model (Postgres)

Create tables:

call_connect_settings

business_id (pk)

enabled boolean

mode enum: AGENT_FIRST | PARALLEL

ring_timeout_seconds int default 20

agent_accept_digits text default "1"

max_agent_attempts int default 2

agent_strategy enum: OWNER | ROUND_ROBIN | ON_DUTY

lead_retry_policy jsonb (e.g. { "retry_minutes": [2,10] })

quiet_hours jsonb (timezone + start/end)

caller_id_strategy enum: BOT_NUMBER | BUSINESS_NUMBER

bot_number_e164 text nullable

business_number_e164 text nullable (used for higher tiers later)

timestamps

call_connect_sessions

id uuid (pk)

business_id

lead_id (string id from LeadBridge)

lead_phone_e164

agent_id nullable

agent_phone_e164 nullable

mode

status enum:

CREATED

CALLING_AGENT

AGENT_ANSWERED

AGENT_ACCEPTED

CALLING_LEAD

LEAD_ANSWERED

BRIDGED

ENDED

FAILED

CANCELED

provider enum default TWILIO

from_number_e164 (the caller id used)

agent_call_sid nullable

lead_call_sid nullable

conference_name nullable

attempt int default 1

failure_reason text nullable

recording_url nullable

timeline jsonb (append-only events)

timestamps

call_connect_events (optional for audit)

session_id

type

payload

created_at

2) Internal APIs (called by LeadBridge)
POST /internal/call-connect/start

Body:

businessId

leadId

leadPhoneE164

leadSummary (string: name/job/location/notes)

agentHint optional (owner id)

source = "thumbtack"

requestedMode optional override

Behavior:

Validate settings (enabled, quiet hours, phone present)

Create session row (idempotency key: businessId+leadId)

Select from_number_e164:

default BOT_NUMBER now (single shared number ok)

later BUSINESS_NUMBER if tier allows

Resolve target agent(s) per strategy

Start calls according to mode

Return:

{ sessionId, status }

POST /internal/call-connect/cancel

Cancels session (if lead already contacted or user toggled off mid-flight)

3) Provider Webhooks (TwiML + status)

Implement endpoints:

POST /webhooks/twilio/voice/agent

Query: sessionId
Return TwiML:

In AGENT_FIRST:

Say whisper summary

Gather digit “1” to accept

If accepted → instruct Sigcore to start lead call and put agent into conference

If not → hang up

In PARALLEL:

Option A: still require “press 1 to accept”, then join conference

Option B (faster MVP): no gather, just join conference (less control)

POST /webhooks/twilio/voice/lead

Query: sessionId
Return TwiML:

Say short opener (“Connecting you now”)

Dial to Conference using conference_name

POST /webhooks/twilio/status

Receive call status callbacks for both legs:

map CallSid -> session

update state machine transitions

detect failures/timeouts

trigger fallback (next agent, SMS notify, retries)

4) Orchestration logic (must implement)
Mode: AGENT_FIRST (recommended default)

Create conference name cc_{sessionId}

Call agent:

calls.create(to=agent_phone, from=from_number, url=/voice/agent?sessionId=...)

When agent accepts:

Place agent into conference (Dial Conference)

Start lead call:

calls.create(to=lead_phone, from=from_number, url=/voice/lead?sessionId=...)

When lead answers: join conference → bridged

Fallback:

If no answer, call next agent until max_agent_attempts

If agent accepts but lead no answer: mark + emit event; optionally schedule retries

Mode: PARALLEL

Create conference name

Call agent (joins conference)

Call lead (joins conference)

Bridged when both answered

Important UX:

If lead answers first, play message or hold music so it’s not dead silence.

5) Events back to LeadBridge

Implement POST from Sigcore → LeadBridge (or publish to your internal bus) for:

call_connect.session.created

call_connect.agent.ringing

call_connect.agent.accepted

call_connect.lead.ringing

call_connect.bridged

call_connect.ended

call_connect.failed + reason

Payload includes sessionId, leadId, timestamps, result.

6) Security + reliability requirements

HMAC signature for internal calls between LeadBridge ↔ Sigcore

Idempotency on /start (avoid duplicate sessions on retries)

Rate-limit per business (avoid “call storms”)

Store provider webhooks raw payload for debugging

7) Acceptance tests

Agent-first happy path: agent answers+press1, lead answers, bridged

Agent doesn’t answer → tries next agent → fails after max

Agent answers but declines (no digit) → fallback

Lead no answer → session ends with lead_no_answer

Parallel happy path

Quiet hours prevents start