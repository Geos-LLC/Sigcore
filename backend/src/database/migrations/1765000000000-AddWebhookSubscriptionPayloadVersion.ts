import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds payload_version to webhook_subscriptions.
 *
 * All pre-existing rows are backfilled to 'v1' via the column DEFAULT —
 * that locks every current SF / LeadBridge / Callio / HireFunnel
 * subscription onto the existing emit shape with zero behavioral
 * change. The service layer (OutboundWebhooksService.createSubscription)
 * defaults NEW subscriptions to 'v2', so the migration can run ahead of
 * any consumer-side opt-in without breaking anyone.
 *
 * Direct DB inserts via tooling adopt 'v1' (the column default), not
 * 'v2'. That's deliberate — anyone bypassing the service layer should
 * also bypass the new contract.
 */
export class AddWebhookSubscriptionPayloadVersion1765000000000
  implements MigrationInterface
{
  name = 'AddWebhookSubscriptionPayloadVersion1765000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "webhook_subscriptions" ADD COLUMN IF NOT EXISTS "payload_version" varchar(8) NOT NULL DEFAULT 'v1'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "webhook_subscriptions" DROP COLUMN IF EXISTS "payload_version"`,
    );
  }
}
