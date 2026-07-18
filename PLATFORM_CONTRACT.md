# Platform Contract

Automated regression barrier for Sigcore's communication provisioning
invariants. Every scenario under `backend/test/platform-contract/` proves
one of the invariants from `Obsidian/Global/Communication Ownership
Model v1.md` holds after any code or schema change.

## What this suite guards

The suite exists because two production incidents (2026-07-13 Spotless,
2026-07-14 LB Twilio credential clobber, 2026-07-18 Natallia + K&D) each
came down to a single missing invariant that unit tests with mocked
repositories could not catch. Every scenario here is a specific
regression barrier tied to one of those invariants.

| # | Scenario | Invariant |
|---|---|---|
| 1 | Communication Provisioning | A brand-new tenant ends up communication-ready via the public service surface. |
| 2 | Idempotent Provisioning | Re-provisioning the same `externalTenantId` never duplicates business / profile / default-profile. |
| 3 | Phone Purchase | `PhoneNumberProvisioningService.purchaseNumber` stamps `TenantPhoneNumber.communication_integration_id`. |
| 4 | Provider Context | `ProviderContextResolver` picks a deterministic integration for a stamped TPN; partial unique index blocks duplicate WORKSPACE-scoped rows; ambiguity surfaces as a structured 409. |
| 5 | Audit | After any legal sequence of public-surface operations, `ProviderContextAuditService.run()` returns zero across every section. |
| 6 | Archive / Restore | Repeated archive+restore cycles produce zero duplicates; readiness stays `ready`. |
| 7 | Concurrency | 10 simultaneous provisions for the same `externalTenantId` collapse to exactly one chain. |
| 8 | Failure Recovery | A mid-provision failure followed by retry heals without orphan rows. |

## Running locally

The suite needs a real Postgres — mocked repositories cannot catch the
partial-unique-index and constraint-level regressions this suite exists
to guard against.

```bash
# 1. Boot Postgres somewhere writable.
docker run -d --name pg-platform \
  -p 5432:5432 \
  -e POSTGRES_PASSWORD=test \
  postgres:15

# 2. Point the suite at it and run.
cd backend
DATABASE_URL=postgresql://postgres:test@localhost:5432/postgres \
  npm run test:platform

# 3. When you're done:
docker rm -f pg-platform
```

The harness runs every migration on boot, then TRUNCATE-CASCADEs every
mutated table between tests. Each scenario file boots the DI graph once
and reseeds a workspace + a WORKSPACE-scoped Twilio integration before
each test. External providers (`TwilioProvider`) are replaced with
`MockTwilioProvider` so the suite is hermetic — no api.twilio.com
calls, no billing.

## Running in CI

`.github/workflows/platform-contract.yml` runs the suite on every PR
against `main` / `staging` and every push to those branches. Postgres
15 is supplied via `services:` — no external infra required.

## Adding a new scenario

1. Add a `NN-name.spec.ts` under `backend/test/platform-contract/scenarios/`.
2. Import `bootHarness` from `../support/harness`.
3. Follow the pattern: `beforeAll(bootHarness)`, `beforeEach(reset+seed)`,
   `afterAll(close)`.
4. Exercise Sigcore through its **public service surface** — never
   INSERT into tables directly, except for read-only assertions.
5. Every scenario must end with `await assertAuditClean()` (or a
   direct `providerContextAuditService.run()` + zero-count assert).
   If the audit is not clean at the end of a scenario, the invariant
   under test is broken.

## Extending the harness

Additional entities the suite touches must be added to two lists in
`support/harness.ts`:

- `TABLES_TO_RESET` — so `reset()` clears the new table between tests.
- `TypeOrmModule.forFeature([...])` and the module imports — so the
  entity is discovered by the entity glob.

For providers with side effects (S3, WhatsApp, Telegram, Email), add
an `.overrideProvider().useClass(MockXxxProvider)` alongside the
existing Twilio mock in `bootHarness()`.

## Interpreting failures

- **"DATABASE_URL missing"** — supply the connection string. See
  "Running locally" above.
- **A scenario throws but audit passes** — the code under test failed
  in a way the audit doesn't catch. Either the audit needs a new
  section or the scenario's assertions are too broad.
- **Audit fails after a scenario** — the invariant under test regressed.
  Rerun with `npm run test:platform -- --testPathPattern=<scenario>`
  to isolate; check which section (`duplicateIntegrations`,
  `unstampedTpns`, `legacyWorkspaceRows`, `tenantsWithoutChain`) tripped.

## Related

- `Obsidian/Global/Communication Ownership Model v1.md` — the invariants.
- `Obsidian/Global/Incident 2026-07-14 Closure.md` — origin story.
- `backend/scripts/audit-provider-context.js` — same audit as a CLI for
  ad-hoc prod checks.
- `GET /admin/provider-context/audit` — same audit as an authenticated
  endpoint for dashboards.
