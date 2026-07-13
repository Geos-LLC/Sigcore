# Communication Identity Provisioning API

**Version:** v1
**Introduced:** Wave-2 Task 6B.2
**Status:** internal (Sigcore ↔ consuming products only)
**Ownership:** Sigcore. Communication infrastructure is Sigcore-owned. Consuming products (Callio today, LeadBridge / ServiceFlow / BehaviorOS in the future) never create or manage Sigcore workspaces, tenants, integrations, or credentials directly. They request a Communication Identity through this endpoint and store only the references it returns.

---

## Endpoint

```
POST  /v1/provisioning/communication-identities
```

### Authentication

Reuses `SigcoreAuthGuard`. Either method is accepted:

- **Service-to-service:** `X-Sigcore-Key: <SIGCORE_SERVICE_KEY>` + `X-Workspace-Id: <caller's own workspace scope>` (guard requires both). The `X-Workspace-Id` used to authenticate is unrelated to what the endpoint creates.
- **External API key:** `x-api-key: <apiKey>`.

No public / anonymous access.

### Request body

```jsonc
{
  "product":              "callio",         // required · enum (currently: "callio")
  "workspaceName":        "Acme Voice",     // required · 1–255 chars
  "externalWorkspaceId":  "cal-ws-abc123",  // required · 1–255 chars · caller's own workspace ID
  "metadata": {                             // optional · opaque · Sigcore does not interpret
    "any": "shape"
  }
}
```

Field notes:

- `product` — the consuming product. Currently only `"callio"` is accepted; new products must be added to `KNOWN_PRODUCTS` in a deliberate PR before they can call this endpoint.
- `externalWorkspaceId` — the caller's own workspace identifier. Sigcore treats it as opaque. It is one half of the idempotency key.
- `workspaceName` — a human-friendly name attached to the Sigcore-owned workspace + tenant rows created. Used only for operator observability.
- `metadata` — free-form JSON, stored verbatim on the identity row. Not read by Sigcore.

### Response — 201 Created

```jsonc
{
  "data": {
    "communicationIdentityId": "8f2b9a…-…-…",       // opaque · use as-is
    "workspaceId":              "1bcbb4e0-…",       // Sigcore-owned workspace UUID
    "tenantId":                 "3c74068e-…",       // Sigcore-owned tenant UUID
    "integrations": [
      {
        "provider":       "twilio",
        "integrationId":  "a537cc3a-…",             // Sigcore-owned integration UUID
        "status":         "active"
      }
    ]
  }
}
```

Response invariants:

- `communicationIdentityId` — treat as opaque. Do not decompose or map to internal Sigcore rows.
- `workspaceId` + `tenantId` — returned today so Callio's `workspaces.sigcore_workspace_id` cache can populate. They are **not contract-stable** and may be removed once consumers stop referencing them.
- `integrations[].integrationId` — used by Task 6B provider clients when calling `/v1/calls/*` endpoints. Opaque.
- `integrations[].status` — always `"active"` on creation. A future flow that supplies real Twilio credentials may transition this. Consumers must handle any `IntegrationStatus` value.

---

## Idempotency

Repeated calls with the same **`(product, externalWorkspaceId)`** pair are guaranteed to return the same Communication Identity — Sigcore does not create duplicates.

Enforcement layers, ordered from cheapest to most robust:

1. **Fast pre-lookup:** the service reads by `(product, external_workspace_id)` before starting a transaction. If a row exists, it returns immediately without opening a transaction.
2. **In-transaction re-read:** if the fast lookup misses, a re-read runs under the transaction just before inserts. Catches races between the fast path and the transaction start.
3. **DB unique index:** `CREATE UNIQUE INDEX uq_communication_identities_product_external ON communication_identities (product, external_workspace_id)`. The final correctness boundary. Any concurrent insert that gets past step 2 produces exactly one winning row; the loser hits Postgres error code `23505`, at which point the service re-reads and returns the winning identity.

Consumers therefore can safely retry this endpoint on network errors without accidentally creating a second identity.

---

## Atomic creation & rollback

All four rows required for a fresh identity are inserted inside a single `dataSource.transaction()`:

```
workspaces      ← Sigcore workspace row
   ↓
tenants         ← tenant scoped to that workspace
   ↓
communication_integrations   ← default Twilio integration (encrypted-empty credentials, status=active)
   ↓
communication_identities     ← the opaque public handle
```

If **any** step throws, the transaction rolls back and no rows persist. Sigcore's state before and after a failed call is identical. This means the endpoint is safe to retry after any transient failure — no orphaned workspace, tenant, or integration is left behind.

---

## Credential ownership

The consuming product **must not supply Twilio credentials** in this call. Communication infrastructure — including the credentials used to speak with providers like Twilio — is Sigcore-owned.

Today the endpoint stores an encrypted-empty credentials blob (`enc("{}")`) with `status = active` per the API contract. A separate Sigcore-owned flow (out of scope for Task 6B.2) will supply real credentials before the integration is used for outbound provider calls. Consumers depend only on the returned `integrationId`; when they invoke `/v1/calls/*` endpoints later, `IntegrationResourceGuard` on Sigcore's side will read the credentials at that point.

Any future proposal to accept credentials in this endpoint's body should be rejected — it would let a compromised product downgrade the trust model.

---

## Out of scope for this endpoint

- Phone number provisioning (already handled by `POST /api/tenants/:tenantId/phone-numbers/purchase`).
- Voice forwarding configuration (Wave-2 Voice Foundation PRs #22 – #25).
- Multi-product provisioning abstractions (LeadBridge / ServiceFlow / BehaviorOS wiring).
- The consuming-product-side change that calls this endpoint (Callio's Task 6B.3).
- Credential rotation and integration lifecycle management.
- Public / anonymous access.

---

## Error responses

| HTTP | Body | Meaning |
|---|---|---|
| 400 | `{"message":"Bad Request", ...}` | Missing / invalid input (product not in `KNOWN_PRODUCTS`, empty `workspaceName`, etc.) |
| 401 | Unauthorized | Missing or invalid `X-Sigcore-Key` / `x-api-key` |
| 500 | Internal Server Error | A non-race DB error occurred. The transaction was rolled back; the identity was **not** created. Safe to retry after the underlying cause is fixed. |

Concurrent `23505` unique-violations are handled internally and do NOT surface as a 500 — the endpoint returns 201 with the winning identity.

---

## Change log

- **2026-07-13 · Task 6B.2** — endpoint created. Introduces `communication_identities` table (migration `1772000000000-AddCommunicationIdentities`). Callio-only `product` enum.
