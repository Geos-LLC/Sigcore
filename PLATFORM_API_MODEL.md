# Sigcore Platform API Model

## Sigcore = Universal Communication SaaS Platform

Sigcore is NOT an internal integration layer for specific apps.
Sigcore IS a multi-tenant communication platform with a universal API.

ServiceFlow, LeadBridge, and Callio are **customers** of Sigcore,
just like any future external SaaS customer would be.

---

## Terminology

| Term | Meaning | NOT |
|------|---------|-----|
| **Tenant** | Top-level Sigcore customer boundary. One per app/service. The platform scope. | NOT sub-accounts, NOT customer businesses, NOT internal workspaces |
| **Product Workspace** | A reference in the business identity registry to a tenant's internal account/workspace. Used for cross-tenant grouping and discovery. | NOT a sub-tenant. NOT used for routing. |
| **Business Identity** | Cross-tenant grouping of the same real-world company across apps. For linking, analytics, and admin visibility. | NOT used for runtime routing. NOT a tenant. |
| **Provider Adapter** | A set of endpoints under `/integrations/{provider}/` that translate between the universal platform and a specific provider API. | NOT a core platform primitive. Provider logic stays in adapters. |

---

## Layer Model

```
┌─────────────────────────────────────────────────────────┐
│  Platform Primitives (universal, provider-agnostic)     │
│  conversations, messages, webhooks, tenants             │
├─────────────────────────────────────────────────────────┤
│  Provider Adapters (per-provider)                       │
│  /integrations/openphone/*, /integrations/twilio/*      │
├─────────────────────────────────────────────────────────┤
│  Business Identity (grouping/discovery — NOT routing)   │
│  businesses, product_workspaces, assets, links          │
├─────────────────────────────────────────────────────────┤
│  App Adapters (external to Sigcore, per-app)            │
│  SF: endpoint_routes  LB: SavedAccount  Callio: Sender │
└─────────────────────────────────────────────────────────┘
```

---

## Universal API Primitives

| Primitive | Description | Scoping |
|-----------|-------------|---------|
| **Tenant** | Top-level Sigcore customer. The platform boundary. No sub-tenants — everything below is the customer's internal structure. | Auth key |
| **Provider Connection** | OpenPhone, Twilio, WhatsApp integration | Per tenant |
| **Communication Endpoint** | Phone number, email, messaging ID | Per tenant + provider |
| **Webhook Subscriber** | URL that receives events from the platform | Per tenant |
| **Conversation** | Thread between endpoint and participant | Per tenant |
| **Message** | Individual message in a conversation | Per conversation |
| **Call** | Voice event in a conversation | Per conversation |

---

## API Surface

### Auth
- `x-api-key` header → resolves to tenant scope
- All endpoints scoped by auth context, not by app-specific paths

### Tenant Management
```
POST   /api/tenants/provision
GET    /api/tenants
GET    /api/tenants/:id
PUT    /api/tenants/:id
```

### Provider Adapters

Each provider has adapter endpoints under `/api/integrations/{provider}/`.
The pattern is universal: connect, list endpoints, disconnect, sync.
The provider-specific path is the adapter implementation.

```
# Pattern: /api/integrations/{provider}/{action}

# OpenPhone adapter:
POST   /api/integrations/openphone/connect
GET    /api/integrations/openphone/numbers
DELETE /api/integrations/openphone/disconnect
POST   /api/integrations/sync

# Twilio adapter:
POST   /api/integrations/twilio/connect
GET    /api/integrations/twilio/numbers

# Future provider follows same pattern:
# POST   /api/integrations/vonage/connect
# GET    /api/integrations/vonage/numbers
```

### Conversations & Messages (provider-agnostic)
```
GET    /api/conversations
GET    /api/conversations/:id/messages
POST   /api/messages
```

### Webhook Subscriptions
```
POST   /api/v1/webhook-subscriptions
GET    /api/v1/webhook-subscriptions
DELETE /api/v1/webhook-subscriptions/:id
```

### Business Identity (admin/discovery — NOT runtime routing)

For cross-tenant company grouping, asset discovery, and analytics.
These endpoints are NOT required for runtime message routing.

```
POST   /api/v1/businesses                    # create/resolve business
GET    /api/v1/businesses                    # list businesses
POST   /api/v1/businesses/:id/workspaces     # register workspace reference
POST   /api/v1/assets                        # create/resolve shared asset
POST   /api/v1/assets/:id/links              # link asset to workspace
GET    /api/v1/assets/:id/workspaces         # discover: which workspaces use this asset?
GET    /api/v1/workspaces/:id/assets         # discover: which assets does this workspace use?
POST   /api/v1/identity/resolve              # admin: find candidate workspaces for an asset
POST   /api/v1/routing/select                # admin: score candidates (suggestions only)
GET    /api/v1/admin/suggest-links           # admin: suggest cross-app business links
```

### Inbound Webhooks (from providers — provider-specific by necessity)
```
POST   /api/webhooks/openphone/:webhookId
POST   /api/webhooks/twilio/sms
POST   /api/webhooks/twilio/voice/:webhookId
```

---

## Runtime Routing Flow

This is how messages actually get routed. Business identity is NOT involved.

```
1. Inbound event arrives at Sigcore (via provider webhook)
2. Sigcore resolves tenant via tenant_phone_numbers lookup
3. Sigcore fans out to webhook subscribers scoped to that tenant
4. Each app receives the event and resolves internally:
   - SF: communication_endpoint_routes (5-step deterministic pipeline)
   - LB: SavedAccount(accountId) → userId
   - Callio: Sender(phone) → workspaceId
```

Business identity resolution is optional — attempted opportunistically
in some webhook handlers but routing works without it.

---

## Design Rules

1. **One API surface for all** — no app-specific endpoints
2. **Scoping via auth** — tenant key determines what data is visible
3. **No business logic in Sigcore** — Sigcore handles communication transport, not CRM/lead/job logic
4. **Adapter layers in apps** — each customer has their own adapter that translates Sigcore primitives to their domain
5. **Works for external customers** — a new SaaS customer uses the same API without Sigcore code changes
6. **Provider logic stays in adapters** — `/integrations/{provider}/*` endpoints handle provider specifics; core endpoints (`/conversations`, `/messages`) are provider-agnostic
7. **Business identity is for grouping, not routing** — runtime routing uses `tenant_phone_numbers` and webhook subscribers; business identity is for admin visibility and cross-app linking

---

## How Apps Use the Platform

### ServiceFlow
```
Tenant: "serviceflow-app"
Connects: OpenPhone via provider adapter
Routes internally: communication_endpoint_routes (deterministic)
Receives events: via webhook subscriber (tenant-scoped)
```

### LeadBridge
```
Tenant: "leadbridge-app"
Connects: Twilio numbers via phone provisioning
Routes internally: SavedAccount → userId
Receives events: via webhook subscriber (tenant-scoped)
```

### Callio
```
Tenant: "callio-app"
Connects: OpenPhone via provider adapter
Routes internally: Sender → workspaceId
Receives events: via webhook subscriber (tenant-scoped)
```

### Future External Customer
```
Tenant: "acme-corp"
Connects: same provider adapters
Routes internally: their own business logic
Receives events: via webhook subscriber (tenant-scoped)
```

---

## Development Rules

- **Don't add app-specific code to Sigcore** — build it in the app's adapter
- **Don't reference app names in Sigcore APIs** — use generic primitives
- **Business identity is a platform feature** — any tenant can use it
- **Webhook forwarding is generic** — Sigcore sends events, doesn't know what subscribers do
- **Provider connections are per-tenant** — each tenant connects their own providers
- **"Tenant" means ONE thing** — the top-level customer boundary. No sub-tenants.
