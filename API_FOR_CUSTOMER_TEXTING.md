# Sigcore SMS API for LeadBridge

## Architecture

```
LeadBridge  --[X-API-Key]-->  Sigcore  ---->  Twilio
                                 |
                          Twilio webhooks
                           (inbound SMS,
                          delivery status)
                                 |
                          Sigcore stores +
                         emits webhook events
                                 |
                           LeadBridge UI
```

**Sigcore owns:** sending SMS, receiving SMS, message status tracking, number selection, Twilio integration.

**LeadBridge owns:** templates, automation logic, UI, billing/tier logic.

---

## Authentication

All `/api/internal/messages/*` endpoints require the header:

```
X-API-Key: sc_tenant_...
```

The workspace is resolved automatically from the API key. No `workspaceId` parameter is needed for auth.

---

## Endpoints

### 1. List Phone Number Assignments

```
GET /api/internal/messages/assignments
```

Returns all phone numbers registered for this workspace. On first call, Sigcore **auto-registers** the Twilio integration phone number as a BOT number (no manual setup needed).

**Response** `200 OK`

```json
[
  {
    "id": "uuid",
    "numberE164": "+19045778584",
    "type": "BOT",
    "region": "US",
    "active": true,
    "createdAt": "2026-02-21T12:00:00.000Z"
  }
]
```

| Field        | Type    | Description                                |
|--------------|---------|--------------------------------------------|
| `id`         | string  | UUID of the assignment                     |
| `numberE164` | string  | Phone number in E.164 format               |
| `type`       | string  | `"BOT"` (shared) or `"DEDICATED"` (per-biz)|
| `region`     | string? | Optional region code (e.g. `"US"`)         |
| `active`     | boolean | Whether the number is currently active      |

---

### 2. Register a Phone Number

```
POST /api/internal/messages/assignments
```

Manually register or update a phone number for this workspace. Usually not needed since numbers are auto-registered from the Twilio integration.

**Request Body**

```json
{
  "numberE164": "+19045778584",
  "type": "BOT",
  "region": "US"
}
```

| Field        | Type   | Required | Description                            |
|--------------|--------|----------|----------------------------------------|
| `numberE164` | string | yes      | Phone number in E.164 format           |
| `type`       | string | yes      | `"BOT"` or `"DEDICATED"`              |
| `region`     | string | no       | Region code (e.g. `"US"`, `"CA"`)     |

**Response** `200 OK` — the created/updated assignment object.

---

### 3. Remove a Phone Number

```
DELETE /api/internal/messages/assignments/:id
```

| Param | Description               |
|-------|---------------------------|
| `id`  | UUID of the assignment    |

**Response** `200 OK`

```json
{ "deleted": true }
```

---

### 4. Send Outbound SMS

```
POST /api/internal/messages/send
```

Sends an SMS via Twilio using the workspace's registered number. Sigcore resolves the sender number automatically (prefers DEDICATED, falls back to BOT).

**Request Body**

```json
{
  "businessId": "uuid",
  "toPhone": "+12125551234",
  "body": "Hi John, thanks for your inquiry!",
  "leadId": "lb_lead_abc123",
  "automationId": "auto_xyz",
  "source": "thumbtack"
}
```

| Field          | Type   | Required | Description                              |
|----------------|--------|----------|------------------------------------------|
| `businessId`   | string | yes      | Workspace/business UUID                  |
| `toPhone`      | string | yes      | Destination phone in E.164 format        |
| `body`         | string | yes      | Message text                             |
| `leadId`       | string | no       | LeadBridge lead ID for tracking          |
| `automationId` | string | no       | Automation that triggered this message   |
| `source`       | string | no       | Origin label (e.g. `"thumbtack"`, `"admin-ui"`) |

**Response** `200 OK`

```json
{
  "messageId": "uuid",
  "status": "queued",
  "providerSid": "SM..."
}
```

---

### 5. List Message History

```
GET /api/internal/messages
```

Returns the last 50 messages for the workspace, newest first.

**Response** `200 OK`

```json
[
  {
    "id": "uuid",
    "businessId": "uuid",
    "leadId": "lb_lead_abc123",
    "direction": "OUTBOUND",
    "fromNumber": "+19045778584",
    "toNumber": "+12125551234",
    "body": "Hi John, thanks for your inquiry!",
    "status": "delivered",
    "providerSid": "SM...",
    "errorCode": null,
    "createdAt": "2026-02-21T12:00:00.000Z"
  }
]
```

| Field         | Type   | Description                                          |
|---------------|--------|------------------------------------------------------|
| `id`          | string | Message UUID                                         |
| `businessId`  | string | Workspace UUID                                       |
| `leadId`      | string?| LeadBridge lead ID (if provided on send)             |
| `direction`   | string | `"OUTBOUND"` or `"INBOUND"`                         |
| `fromNumber`  | string | Sender phone (E.164)                                 |
| `toNumber`    | string | Recipient phone (E.164)                              |
| `body`        | string | Message text                                         |
| `status`      | string | `queued`, `sent`, `delivered`, `undelivered`, `failed`, `received` |
| `providerSid` | string?| Twilio MessageSid                                    |
| `errorCode`   | string?| Twilio error code (on failure)                       |

---

## Twilio Webhooks (configured automatically)

These are called by Twilio, not by LeadBridge. Sigcore configures them automatically when the Twilio integration is set up.

### Inbound SMS

```
POST /api/webhooks/twilio/sms
```

Twilio sends inbound SMS here. Sigcore identifies the workspace by the `To` number via `phone_number_assignments`, stores the message as `INBOUND`, and emits a `sms.message.received` webhook event to LeadBridge.

### Delivery Status

```
POST /api/webhooks/twilio/sms-status
```

Twilio sends delivery status updates here. Sigcore updates the message status (`queued` -> `sent` -> `delivered` or `failed`) and emits:
- `sms.message.delivered` on successful delivery
- `sms.message.failed` on failure/undelivered

---

## Number Strategy

| Tier   | Number Type | Description                                           |
|--------|-------------|-------------------------------------------------------|
| Lower  | `BOT`       | Shared Twilio number across workspaces in a region    |
| Higher | `DEDICATED` | Per-business number, preferred for outbound if exists |

Sender resolution order: DEDICATED (if active) -> BOT (fallback).

---

## Quick Start

1. Get your tenant API key from the Sigcore admin panel
2. Call `GET /api/internal/messages/assignments` to auto-register your Twilio number
3. Send a test SMS with `POST /api/internal/messages/send`
4. Check delivery status with `GET /api/internal/messages`
