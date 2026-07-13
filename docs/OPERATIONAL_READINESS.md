# Communication Integration Operational Readiness

**Status:** shipped as of Task 6B.5A (2026-07-13). Extends the Task 6B.2 Communication Identity API with an operational-readiness contract and a lazy Twilio-subaccount credential-provisioning path.

**Owners:** Sigcore.

---

## What this contract adds

Prior to Task 6B.5A, integration rows created by `POST /v1/provisioning/communication-identities` had `status = active` but an encrypted-empty credentials blob. Any downstream Twilio operation (number search, purchase, hangup, recording) failed with `"username is required"` because the Twilio SDK could not authenticate. Consumers had no way to distinguish "row exists" from "row can service ops".

Task 6B.5A introduces:

1. **Operational readiness state** on `communication_integrations`.
2. **Lazy Twilio-subaccount provisioning** on first voice-number purchase.
3. **Backward-compatible response extension** on both provisioning and ensure endpoints.

## Semantic states

```
pending_credentials  →  provisioning  →  ready
                             │
                             ↓
                           error  ⇄  provisioning  (retry)
```

| State | Meaning | Consumer expectation |
|---|---|---|
| `pending_credentials` | Encrypted-empty credentials; provisioning has not started. Initial state for rows created by `POST /v1/provisioning/communication-identities`. | Do not route ops. Trigger provisioning via first voice-number purchase. |
| `provisioning` | Subaccount / credentials / preflight is in-flight. Transient. | Wait; retry idempotent. |
| `ready` | Sigcore has verified provider preflight (auth + account active + phone-number API reachable). | Safe to route ops. |
| `error` | Provisioning or preflight failed. | Machine-readable code in `operationalReason`; retry allowed. |
| `NULL` (grandfathered) | Pre-6B.5A row; treated as `ready` by application code and reported as `ready` in API responses. | Preserved for the pilot workspace. |

## Reason codes

Reported in `operationalReason` when `operationalStatus ∈ {pending_credentials, error}`.

| Code | When |
|---|---|
| `TWILIO_CREDENTIALS_NOT_CONFIGURED` | Initial state for freshly provisioned rows. Also set when Sigcore's master Twilio env vars are unset when the provisioner runs. |
| `TWILIO_SUBACCOUNT_CREATE_FAILED` | Twilio's `.accounts.create()` returned an error, OR the row is in an unrecoverable partial state (SID persisted but auth token lost). |
| `TWILIO_AUTH_FAILED` | Preflight `.accounts(sid).fetch()` returned 401/403. |
| `TWILIO_PROVIDER_UNREACHABLE` | Preflight timed out or hit a transport error. |
| `TWILIO_SUBACCOUNT_INACTIVE` | Preflight reports the subaccount is `closed` / `suspended`. |
| `TWILIO_PREFLIGHT_LIST_FAILED` | Preflight `.availablePhoneNumbers('US').local.list()` failed. |

Unknown codes should be treated as opaque and logged verbatim.

## The lazy-provisioning trigger

**Where it fires:** `PhoneNumberProvisioningService.purchaseNumber()`, immediately before the actual Twilio `incomingPhoneNumbers.create()` call. The provisioner short-circuits when the integration is already `ready` or grandfathered.

**Why lazy (not eager on identity creation):** avoids minting Twilio subaccounts for workspaces that never enable Voice. Sigcore subaccounts are irreversible (`.update({status:'closed'})` releases numbers but does not delete the subaccount), so we only mint when the user commits to a Voice purchase.

**Concurrency:** the provisioner opens a transaction and runs `SELECT ... FOR UPDATE` on the integration row. Concurrent purchases for the same workspace serialize; only one subaccount is minted.

**Idempotency:** on retry after preflight failure, the persisted subaccount SID + auth token are reused (no duplicate mint). On retry after subaccount-create failure (no SID persisted yet), a fresh subaccount is minted.

## Verification model

Sigcore verifies readiness against Twilio API responses, not just DB state:

1. Credentials decrypt to a well-formed `{accountSid, authToken}` pair.
2. `.api.accounts(sid).fetch()` returns 2xx.
3. Response `status === 'active'`.
4. `.availablePhoneNumbers('US').local.list({limit: 1})` returns 2xx (free read).

Never places a billable resource change. Failures update `operationalStatus = 'error'` with the appropriate reason; the row is preserved for retry.

## API contract additions

### `POST /v1/provisioning/communication-identities`

**Before (Task 6B.2):**
```jsonc
{
  "workspaceId": "…",
  "tenantId": "…",
  "integrations": [
    { "provider": "twilio", "integrationId": "…", "status": "active" }
  ]
}
```

**After (Task 6B.5A):**
```jsonc
{
  "workspaceId": "…",
  "tenantId": "…",
  "integrations": [
    {
      "provider": "twilio",
      "integrationId": "…",
      "status": "active",
      "operationalStatus": "pending_credentials",
      "operationalReason": "TWILIO_CREDENTIALS_NOT_CONFIGURED"
    }
  ]
}
```

Existing consumers that read only the pre-6B.5A fields see the unchanged shape. The new fields are additive.

### `POST /v1/integrations/ensure`

Response extended identically. Rows created via the ensure path (pilot registrar's boot behavior) with real credentials get `operationalStatus: NULL` in the DB and report `"ready"` in the response — this preserves pilot behavior byte-for-byte.

## Compensation & retry

- Provisioning failure at any step leaves the identity present. Callio never rolls back Sigcore state.
- Retry the same purchase; the provisioner re-runs from the appropriate resume point.
- The `error` state is *repair-eligible* when the row carries both `providerSubaccountSid` and non-empty credentials. In that case the next retry re-runs preflight against the persisted subaccount. If preflight now succeeds, the row transitions to `ready`.
- The `error` state is *operator-recoverable only* when the row has `providerSubaccountSid` but empty credentials (auth token lost mid-flight). Twilio does not re-emit the auth token, so the next retry marks `TWILIO_SUBACCOUNT_CREATE_FAILED` with a clear operator-recovery message rather than minting a duplicate subaccount.

## Security invariants

- Master Twilio credentials read from `SIGCORE_TWILIO_MASTER_ACCOUNT_SID` + `SIGCORE_TWILIO_MASTER_AUTH_TOKEN` env vars (fallback to legacy `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN`). Never returned in an API response, never logged.
- Subaccount credentials encrypted at rest via `EncryptionService` (single-key AES). Never returned in an API response, never logged. The subaccount SID is duplicated to a plaintext column (`provider_subaccount_sid`) for observability; the auth token is not.
- Cross-workspace / cross-tenant access continues to be blocked by `IntegrationResourceGuard` — the Task 6B.5A columns do not change that surface.
- No product ever supplies a Twilio Account SID / auth token via a public API. The ensure endpoint's credential-rotation path is kept for the pilot migration only.

## Migration + rollback

- Migration `1773000000000-AddCommunicationIntegrationOperationalStatus` adds four nullable columns to `communication_integrations`. Additive — no existing data touched.
- `down()` is a no-op per the Wave-2 additive-only invariant.
- Rolling back the deploy is safe: existing rows tolerate absence of the columns (readers use `?? OperationalStatus.READY`), and any provisioned subaccounts on Twilio's side simply become orphaned (they can be cleaned up out-of-band by closing them).
- Task 6B.2 provisioning API's pre-6B.5A behavior can be restored by reverting the two lines in `provisioning.service.ts` that set `operationalStatus` + `operationalReason` on the new integration row.

## Cleanup

Subaccounts cannot be deleted. Administrative cleanup calls `TwilioProvider.closeSubaccount(masterCreds, subaccountSid)` which updates the subaccount to `status: closed` on Twilio (irreversibly releases any numbers). Sigcore-side DB cleanup then follows the [existing cleanup procedure](./SIGCORE_CLEANUP_PROCEDURE.md) — `communication_identities → communication_integrations → tenants → workspaces`.

## Follow-up work

- **Multi-provider readiness:** the state machine is Twilio-only today. Extending to OpenPhone / WhatsApp requires a per-provider provisioner service; the `operationalStatus` column is provider-agnostic.
- **Credential-rotation runbook:** when a subaccount's auth token needs to be rotated, we currently have no automated flow — Twilio requires the operator to reset the token via the console, then update the encrypted blob out-of-band. A future rotation service should tackle this.
- **Preflight cache:** `operational_last_verified_at` is stamped but not yet consumed. A future consumer could skip preflight when the timestamp is recent enough.
