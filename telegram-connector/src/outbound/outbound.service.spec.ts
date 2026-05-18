import { OutboundService } from './outbound.service';

function buildAccount() {
  return {
    id: 'acct_1',
    tenantId: 'ten_1',
    mode: 'bot',
    botTokenEncrypted: 'enc:enc:enc',
    status: 'connected',
  };
}

describe('OutboundService', () => {
  it('rejects cross-tenant account access via accounts.getForTenant', async () => {
    const accounts = {
      getForTenant: jest.fn().mockRejectedValue({ response: { error: 'telegram_account_not_found' } }),
    };
    const transports = { forAccount: jest.fn() };
    const idem = { lookup: jest.fn(), record: jest.fn() };
    const svc = new OutboundService(accounts as any, transports as any, idem as any);

    await expect(
      svc.send({ tenantId: 'wrong', accountId: 'acct_1', telegramChatId: '1', text: 'hi' }),
    ).rejects.toBeDefined();
    expect(transports.forAccount).not.toHaveBeenCalled();
  });

  it('returns the prior result on idempotencyKey replay (DB-backed)', async () => {
    const accounts = { getForTenant: jest.fn().mockResolvedValue(buildAccount()) };
    const transports = { forAccount: jest.fn() };
    const idem = {
      lookup: jest.fn().mockResolvedValue({
        externalMessageId: 'previous-id',
        status: 'sent',
      }),
      record: jest.fn(),
    };
    const svc = new OutboundService(accounts as any, transports as any, idem as any);

    const out = await svc.send({
      tenantId: 'ten_1',
      accountId: 'acct_1',
      telegramChatId: '1',
      text: 'hi',
      idempotencyKey: 'k',
    });
    expect(out.idempotentReplay).toBe(true);
    expect(out.externalMessageId).toBe('previous-id');
    expect(transports.forAccount).not.toHaveBeenCalled();
  });

  it('sends via the selected transport and records idempotency on success', async () => {
    const accounts = { getForTenant: jest.fn().mockResolvedValue(buildAccount()) };
    const transport = {
      sendMessage: jest.fn().mockResolvedValue({ ok: true, status: 'sent', externalMessageId: 'new-id' }),
    };
    const transports = { forAccount: jest.fn().mockReturnValue(transport) };
    const idem = { lookup: jest.fn().mockResolvedValue(null), record: jest.fn() };

    const svc = new OutboundService(accounts as any, transports as any, idem as any);
    const out = await svc.send({
      tenantId: 'ten_1', accountId: 'acct_1', telegramChatId: '1', text: 'hi', idempotencyKey: 'k',
    });
    expect(out.ok).toBe(true);
    expect(out.externalMessageId).toBe('new-id');
    expect(idem.record).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'ten_1', accountId: 'acct_1', idempotencyKey: 'k', externalMessageId: 'new-id',
    }));
  });

  it('does not record idempotency when the send fails', async () => {
    const accounts = { getForTenant: jest.fn().mockResolvedValue(buildAccount()) };
    const transport = {
      sendMessage: jest.fn().mockResolvedValue({ ok: false, status: 'failed', error: 'boom' }),
    };
    const transports = { forAccount: jest.fn().mockReturnValue(transport) };
    const idem = { lookup: jest.fn().mockResolvedValue(null), record: jest.fn() };

    const svc = new OutboundService(accounts as any, transports as any, idem as any);
    const out = await svc.send({
      tenantId: 'ten_1', accountId: 'acct_1', telegramChatId: '1', text: 'hi', idempotencyKey: 'k',
    });
    expect(out.ok).toBe(false);
    expect(out.status).toBe('failed');
    expect(idem.record).not.toHaveBeenCalled();
  });
});
