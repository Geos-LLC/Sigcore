TASK — Fix Tenant Isolation for OpenPhone/QUO via Sigcore (Remove App-Key Fallback)
Context

We currently have a cross-tenant leak: when a LeadBridge tenant connects OpenPhone/QUO, LeadBridge falls back to the app-level SIGCORE_API_KEY if the tenant doesn’t have its own Sigcore key. That causes the tenant’s OpenPhone/QUO connection + phone numbers to be stored under the admin Sigcore workspace, so admin can see tenant numbers.

Goal

Enforce strict tenant isolation:

Each LeadBridge tenant must use its own Sigcore tenant/workspace API key

No tenant-scoped operation may ever use the app-level SIGCORE_API_KEY

SIGCORE_API_KEY is allowed only for provisioning (creating a tenant workspace) and internal admin-only operations.

Part 1 — SIGCORE CHANGES
1. Add / Verify “Provision Tenant” endpoint (Platform/Admin only)
Implement (or confirm exists):

POST /v1/provision/tenant

Auth: platform/admin key only (the app-level SIGCORE_API_KEY)

Body (example):

{
  "externalTenantId": "leadbridge:<leadbridgeTenantId>",
  "displayName": "LeadBridge - <tenantName>"
}

Response:

{
  "tenantId": "<sigcoreTenantId>",
  "apiKey": "<sigcoreTenantApiKey>"
}
Rules

If externalTenantId already exists, return the same tenant + a new rotated key OR return existing key depending on policy. Prefer:

return existing tenantId

create a new key (rotate) only if explicitly requested by param rotate=true

Store mapping externalTenantId -> tenantId

Store tenant keys securely; allow multiple keys per tenant if you support rotation.

DoD

Provision endpoint exists and returns a tenant-scoped key that can only access that tenant’s resources.

2. Add “WhoAmI / Tenant Context” debug endpoint (tenant key)

Implement:
GET /v1/whoami

Auth: tenant api key

Response:

{
  "tenantId": "<sigcoreTenantId>",
  "externalTenantId": "<externalTenantId or null>"
}
DoD

Used for debugging to confirm which tenant the request is scoped to.

3. Enforce strict tenant scoping on all OpenPhone/QUO resources

Audit Sigcore handlers for:

“connect provider”

“list phone numbers”

“send message”

“webhooks ingestion” mapping
Ensure every DB query is filtered by tenantId derived from the auth key (NOT from request params).

DoD

No endpoint can access another tenant’s resources even if request params attempt to.

4. Optional: Protect against platform key usage in tenant endpoints

If the platform key can call tenant endpoints today, add one of:

denylist: platform key cannot call /v1/openphone/*, /v1/quo/*, /v1/numbers/*

OR require header X-Tenant-Key: true for those endpoints

OR mark keys with keyType = PLATFORM | TENANT and reject PLATFORM on tenant endpoints.

DoD

Even if LeadBridge mistakenly uses SIGCORE_API_KEY, tenant endpoints reject it.

Part 2 — LEADBRIDGE CHANGES
1. DB: store Sigcore tenant credentials per LeadBridge tenant

Add fields to LeadBridge “tenant/business” table (or equivalent):

sigcoreTenantId (string, nullable)

sigcoreTenantApiKey (string, nullable, encrypted/secret storage)

sigcoreProvisionedAt (timestamp, nullable)

Migration + TypeORM entity update.

DoD

Each LeadBridge tenant can store its own Sigcore tenant key.

2. Remove fallback to app-level SIGCORE_API_KEY for tenant actions

Find connectSigcore / Sigcore client init logic.
Current bad behavior:

if no per-tenant key: use env SIGCORE_API_KEY

Replace with:

getTenantSigcoreKeyOrThrow(tenantId) helper

For any tenant-scoped operation (connect OpenPhone/QUO, list numbers, send SMS, etc):

if key missing => throw 409/400 with code SIGCORE_TENANT_NOT_PROVISIONED

Error response contract
{
  "error": "SIGCORE_TENANT_NOT_PROVISIONED",
  "message": "Phone workspace is not provisioned for this tenant."
}
DoD

No tenant endpoint can execute using platform key.

3. Add “Provision Sigcore Workspace” service (server-side)

Implement backend service:
ensureSigcoreTenantProvisioned(leadbridgeTenantId)

If sigcoreTenantApiKey exists: return

Else:

call Sigcore POST /v1/provision/tenant using platform env key SIGCORE_API_KEY

store returned tenantId + apiKey into LeadBridge tenant record

set sigcoreProvisionedAt

Expose API endpoint for UI:
POST /api/settings/phone/provision

Auth: tenant admin user

Calls ensureSigcoreTenantProvisioned

Returns ok: true

DoD

A tenant admin can provision in one click; key stored.

4. Update Phone Settings UX flow

On Phone Settings page:

Call GET /api/settings/phone/status

returns { provisioned: boolean }

If provisioned=false:

show “Enable Phone Workspace” button → calls POST /api/settings/phone/provision

disable/hide Connect OpenPhone/QUO until provisioned

If provisioned=true:

enable Connect OpenPhone/QUO

number listing uses tenant Sigcore key

DoD

Tenant cannot connect OpenPhone/QUO until provisioned.

5. Add server-side guard in all provider routes

For routes:

/api/openphone/connect

/api/openphone/numbers

/api/messages/send (if it calls Sigcore)

any “phone” action
Add guard:

loads LeadBridge tenant

asserts sigcoreTenantApiKey exists

otherwise returns SIGCORE_TENANT_NOT_PROVISIONED

DoD

Even if frontend is bypassed, backend prevents fallback/leak.

Acceptance Tests (must pass)
Test A — No leakage

Tenant A provisions workspace, connects OpenPhone/QUO, imports numbers.

Admin (platform tenant) opens Phone Settings.
✅ Admin does NOT see Tenant A numbers.

Test B — Hard fail without provisioning

New Tenant B tries connect OpenPhone/QUO without provisioning.
✅ API returns SIGCORE_TENANT_NOT_PROVISIONED and UI shows provisioning CTA.

Test C — Tenant isolation in Sigcore

Use Tenant A Sigcore key → list numbers.

Use Tenant B Sigcore key → list numbers.
✅ Each key sees only its own numbers.

Test D — Platform key blocked from tenant endpoints (if implemented)

Call /v1/openphone/numbers using platform key.
✅ 403/401 denied.

Notes / Implementation Details

LeadBridge should treat sigcoreTenantApiKey as a secret (encrypt at rest).

Sigcore should derive tenantId strictly from API key auth middleware.

Remove any code path that uses request-provided tenantId for scoping.