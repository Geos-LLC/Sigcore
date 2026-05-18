import { MTProtoTransport } from './mtproto.transport';

describe('MTProtoTransport (MVP: must stay disabled)', () => {
  it('refuses to send when TELEGRAM_MTPROTO_ENABLED is unset (default off)', async () => {
    delete process.env.TELEGRAM_MTPROTO_ENABLED;
    const t = new MTProtoTransport();
    const out = await t.sendMessage({} as any);
    expect(out.ok).toBe(false);
    expect(out.error).toBe('mtproto_disabled');
  });

  it('still refuses when explicitly enabled — implementation is intentionally deferred', async () => {
    process.env.TELEGRAM_MTPROTO_ENABLED = 'true';
    const t = new MTProtoTransport();
    const out = await t.sendMessage({} as any);
    expect(out.ok).toBe(false);
    expect(out.error).toBe('mtproto_outbound_not_implemented');
    delete process.env.TELEGRAM_MTPROTO_ENABLED;
  });
});
