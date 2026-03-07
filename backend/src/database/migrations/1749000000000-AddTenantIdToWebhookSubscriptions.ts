import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTenantIdToWebhookSubscriptions1749000000000
  implements MigrationInterface
{
  name = 'AddTenantIdToWebhookSubscriptions1749000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "webhook_subscriptions" ADD COLUMN IF NOT EXISTS "tenant_id" varchar`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_webhook_subscriptions_tenant_id" ON "webhook_subscriptions" ("tenant_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_webhook_subscriptions_tenant_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_subscriptions" DROP COLUMN IF EXISTS "tenant_id"`,
    );
  }
}
