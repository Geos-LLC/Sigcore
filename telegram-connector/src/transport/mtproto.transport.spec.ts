import { MTProtoTransport, mtprotoEnabled } from './mtproto.transport';
import { TelegramAccountRecord } from '../accounts/account.types';

function makeAccount(): TelegramAccountRecord {
  return {
    id: 'a1',
    tenantId: 't1',
    provider: 'telegram',
    mode: 'mtproto',
    displayName: 'op',
    status: 'connected',
    reconnectAttempts: 0,
    createdAt: '',
    updatedAt: '',
  };
}

describe('MTProtoTransport (disabled by default)', () => {
  const orig = process.env.TELEGRAM_MTPROTO_ENABLED;
  afterEach(() => {
    if (orig === undefined) delete process.env.TELEGRAM_MTPROTO_ENABLED;
    else process.env.TELEGRAM_MTPROTO_ENABLED = orig;
  });

  it('refuses to send when the feature flag is off', async () => {
    delete process.env.TELEGRAM_MTPROTO_ENABLED;
    expect(mtprotoEnabled()).toBe(false);
    const t = new MTProtoTransport();
    const r = await t.sendMessage({ account: makeAccount(), telegramChatId: '1', text: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('mtproto_disabled');
  });

  it('returns mtproto_outbound_not_implemented when the flag is on (driver pending)', async () => {
    process.env.TELEGRAM_MTPROTO_ENABLED = 'true';
    expect(mtprotoEnabled()).toBe(true);
    const t = new MTProtoTransport();
    const r = await t.sendMessage({ account: makeAccount(), telegramChatId: '1', text: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('mtproto_outbound_not_implemented');
  });
});
