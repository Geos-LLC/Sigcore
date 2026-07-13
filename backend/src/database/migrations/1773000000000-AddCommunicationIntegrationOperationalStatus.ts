import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Wave-2 Task 6B.5A — operational-readiness contract on
 * `communication_integrations`.
 *
 * Adds four nullable columns capturing whether an integration can service
 * provider operations end-to-end, distinct from the existing lifecycle
 * `status` (active | inactive | error). The distinction matters because
 * Task 6B.2 provisioning creates integration rows with an encrypted-empty
 * credentials blob and `status = 'active'`; the row exists but cannot
 * service Twilio calls until a Sigcore-owned credential-provisioning flow
 * populates it. Consumers (Callio's registrar, phone-number purchase code)
 * must consult `operational_status` to know when it is safe to route
 * traffic.
 *
 * Columns:
 *
 *   operational_status              varchar(32)  nullable
 *     enum-shaped semantics enforced by application code:
 *       - NULL                   grandfathered rows from before Task 6B.5A;
 *                                treated as `ready` by application layer
 *                                so the production pilot (workspace
 *                                6e378229 → sigcore workspace 1bcbb4e0)
 *                                continues to work unchanged.
 *       - `pending_credentials`  row has empty encrypted credentials and
 *                                needs Sigcore-owned provider setup before
 *                                any Twilio call will succeed. Task 6B.2
 *                                provisioning-API creates fresh rows in
 *                                this state.
 *       - `provisioning`         subaccount / API-key / credentials work
 *                                is in-flight. Transient; concurrent
 *                                callers observe this and wait.
 *       - `ready`                Sigcore has verified via provider preflight
 *                                that the integration can service ops.
 *       - `error`                Provisioning or preflight failed. Machine-
 *                                readable reason lives in
 *                                `operational_reason`; retry is allowed.
 *
 *   operational_reason              varchar(128) nullable
 *     Machine-parseable code like `TWILIO_CREDENTIALS_NOT_CONFIGURED`,
 *     `TWILIO_AUTH_FAILED`, `TWILIO_SUBACCOUNT_CREATE_FAILED`. Never a
 *     free-form message; the log line adjacent to the transition carries
 *     the detail. Consumers should treat unknown codes as opaque.
 *
 *   provider_subaccount_sid          varchar(64)  nullable
 *     Twilio subaccount SID (`ACxxxxxxxx...`) when the workspace has its
 *     own Sigcore-owned Twilio subaccount. Duplicates the value already
 *     inside the encrypted credentials blob, but stored plainly for
 *     observability, admin UIs, and cleanup queries. Never `accountSid`
 *     of the master account — that would break isolation.
 *
 *   operational_last_verified_at    TIMESTAMP    nullable
 *     Timestamp of the last successful provider preflight against this
 *     integration. Populated when `operational_status` transitions to
 *     `ready`. Callers may re-preflight lazily if the timestamp is stale.
 *
 * Additive-only: no existing column is altered, no data is backfilled, no
 * existing row is changed. Application code interprets NULL as the pilot's
 * legacy `ready` state so the pilot workspace's runtime behavior is
 * unchanged by this migration.
 *
 * Rollback (`down`) is a no-op per Wave-2's additive-only invariant. If a
 * true rollback is ever needed, drop the columns in a follow-up migration
 * once all readers have been updated to tolerate their absence.
 */
export class AddCommunicationIntegrationOperationalStatus1773000000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Guard each column with IF NOT EXISTS so re-running is safe.
    await queryRunner.query(`
      ALTER TABLE "communication_integrations"
        ADD COLUMN IF NOT EXISTS "operational_status" varchar(32) NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "communication_integrations"
        ADD COLUMN IF NOT EXISTS "operational_reason" varchar(128) NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "communication_integrations"
        ADD COLUMN IF NOT EXISTS "provider_subaccount_sid" varchar(64) NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "communication_integrations"
        ADD COLUMN IF NOT EXISTS "operational_last_verified_at" TIMESTAMP NULL
    `);

    // Index on operational_status for admin dashboards / ops queries that
    // want to enumerate "which workspaces are pending credentials?" cheaply.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "ix_comm_integrations_operational_status"
        ON "communication_integrations" ("operational_status")
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // No-op. Wave-2 additive-only invariant: down migrations do not remove
    // schema. If a rollback is ever needed, ship a follow-up migration
    // once all readers tolerate NULL for the removed columns.
  }
}
