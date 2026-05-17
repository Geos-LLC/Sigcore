import { DedupeService } from './dedupe.service';

describe('DedupeService', () => {
  it('returns true for first observation and false for duplicates', () => {
    const d = new DedupeService();
    const key = d.key({ tenantId: 't', accountId: 'a', externalMessageId: '1:42' });
    expect(d.observe(key)).toBe(true);
    expect(d.observe(key)).toBe(false);
    expect(d.observe(key)).toBe(false);
  });

  it('treats different tenants as different keys', () => {
    const d = new DedupeService();
    const k1 = d.key({ tenantId: 't1', accountId: 'a', externalMessageId: '1:42' });
    const k2 = d.key({ tenantId: 't2', accountId: 'a', externalMessageId: '1:42' });
    expect(d.observe(k1)).toBe(true);
    expect(d.observe(k2)).toBe(true);
  });

  it('falls back to chat+message+timestamp when no stable id available', () => {
    const d = new DedupeService();
    const k = d.fallbackKey({
      tenantId: 't',
      accountId: 'a',
      telegramChatId: '-100',
      messageId: 42,
      timestamp: 1700000000,
    });
    expect(d.observe(k)).toBe(true);
    expect(d.observe(k)).toBe(false);
  });
});