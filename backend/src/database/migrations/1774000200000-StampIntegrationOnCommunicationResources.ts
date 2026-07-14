import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Incident 2026-07-14 Phase 2 — stamp `communication_integration_id` on
 * every communication resource that touches provider infrastructure.
 *
 * Rationale: today, resources like `communication_calls` carry the owning
 * integration only via `metadata.integrationId` (a JSONB field, no FK, not
 * queryable in bulk). The ProviderContextResolver's rule 2
 * (`by_stamped_resource`) needs a first-class column to resolve a
 * `providerResourceSid` back to its integration deterministically.
 *
 * Applied to the 5 tables verified to exist in prod schema:
 *   - communication_calls
 *   - call_connect_sessions
 *   - sms_messages
 *   - communication_messages
 *   - phone_number_orders
 *
 * All columns nullable + FK RESTRICT + index. NULL is the grandfathered
 * state for rows written before this migration; the resolver's rule 2
 * falls back to `metadata.integrationId` when the column is NULL.
 *
 * Additive-only, reversible.
 */
export class StampIntegrationOnCommunicationResources1774000200000
  implements MigrationInterface
{
  private static readonly TARGETS: Array<{
    table: string;
    fkName: string;
    indexName: string;
  }> = [
    {
      table: 'communication_calls',
      fkName: 'fk_communication_calls_communication_integration_id',
      indexName: 'IX_communication_calls_communication_integration_id',
    },
    {
      table: 'call_connect_sessions',
      fkName: 'fk_call_connect_sessions_communication_integration_id',
      indexName: 'IX_call_connect_sessions_communication_integration_id',
    },
    {
      table: 'sms_messages',
      fkName: 'fk_sms_messages_communication_integration_id',
      indexName: 'IX_sms_messages_communication_integration_id',
    },
    {
      table: 'communication_messages',
      fkName: 'fk_communication_messages_communication_integration_id',
      indexName: 'IX_communication_messages_communication_integration_id',
    },
    {
      table: 'phone_number_orders',
      fkName: 'fk_phone_number_orders_communication_integration_id',
      indexName: 'IX_phone_number_orders_communication_integration_id',
    },
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const { table, fkName, indexName } of StampIntegrationOnCommunicationResources1774000200000.TARGETS) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
          ADD COLUMN IF NOT EXISTS "communication_integration_id" uuid NULL
      `);
      await queryRunner.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = '${fkName}'
          ) THEN
            ALTER TABLE "${table}"
              ADD CONSTRAINT "${fkName}"
              FOREIGN KEY ("communication_integration_id")
              REFERENCES "communication_integrations"("id")
              ON DELETE RESTRICT;
          END IF;
        END $$;
      `);
      await queryRunner.query(`
        CREATE INDEX IF NOT EXISTS "${indexName}"
          ON "${table}" ("communication_integration_id")
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const { table, fkName, indexName } of StampIntegrationOnCommunicationResources1774000200000.TARGETS) {
      await queryRunner.query(`DROP INDEX IF EXISTS "${indexName}"`);
      await queryRunner.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = '${fkName}'
          ) THEN
            ALTER TABLE "${table}"
              DROP CONSTRAINT "${fkName}";
          END IF;
        END $$;
      `);
      await queryRunner.query(`
        ALTER TABLE "${table}"
          DROP COLUMN IF EXISTS "communication_integration_id"
      `);
    }
  }
}
