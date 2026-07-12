import type { QueryRunner } from 'typeorm';
import { AddTenantVoiceInboundUrl1771000000000 } from '../1771000000000-AddTenantVoiceInboundUrl';

// PR 2 migration structural test.
//
// Verifies:
//   - up() adds `voice_inbound_url` to `tenants` as nullable text (no DEFAULT)
//   - up() uses IF NOT EXISTS so a partial re-apply after crash is idempotent
//   - down() drops the column with IF EXISTS so rollback is idempotent
//   - Neither direction touches unrelated columns

class SqlCaptureRunner {
  public readonly queries: string[] = [];
  async query(sql: string): Promise<void> {
    this.queries.push(sql);
  }
}

describe('AddTenantVoiceInboundUrl1771000000000', () => {
  it('up() adds tenants.voice_inbound_url as nullable text with IF NOT EXISTS', async () => {
    const runner = new SqlCaptureRunner();
    const migration = new AddTenantVoiceInboundUrl1771000000000();
    await migration.up(runner as unknown as QueryRunner);

    expect(runner.queries).toHaveLength(1);
    const sql = runner.queries[0];
    expect(sql).toMatch(/ALTER TABLE "tenants"/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS/i);
    expect(sql).toMatch(/"voice_inbound_url"\s+text/i);
    // Nullable — no NOT NULL, no DEFAULT.
    expect(sql).not.toMatch(/NOT NULL/i);
    expect(sql).not.toMatch(/DEFAULT/i);
  });

  it('down() drops tenants.voice_inbound_url with IF EXISTS', async () => {
    const runner = new SqlCaptureRunner();
    const migration = new AddTenantVoiceInboundUrl1771000000000();
    await migration.down(runner as unknown as QueryRunner);

    expect(runner.queries).toHaveLength(1);
    const sql = runner.queries[0];
    expect(sql).toMatch(/ALTER TABLE "tenants"/i);
    expect(sql).toMatch(/DROP COLUMN IF EXISTS "voice_inbound_url"/i);
  });

  it('does not touch webhook_url or webhook_secret in either direction', async () => {
    const migration = new AddTenantVoiceInboundUrl1771000000000();
    const upRunner = new SqlCaptureRunner();
    const downRunner = new SqlCaptureRunner();
    await migration.up(upRunner as unknown as QueryRunner);
    await migration.down(downRunner as unknown as QueryRunner);
    for (const sql of [...upRunner.queries, ...downRunner.queries]) {
      expect(sql).not.toMatch(/webhook_url/i);
      expect(sql).not.toMatch(/webhook_secret/i);
    }
  });
});
