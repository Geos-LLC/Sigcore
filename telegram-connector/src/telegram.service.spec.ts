import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TelegramService } from './telegram.service';
import { AccountStoreService } from './accounts/account-store.service';
import { DurableEventStoreService } from './inbound/durable-event-store.service';
import { EncryptionService } from './common/encryption.service';
import { SigcoreIngestService } from './events/sigcore-ingest.service';
import { TransportFactory } from './transport/transport.factory';
import { BotTransport } from './transport/bot.transport';
import { MTProtoTransport } from './transport/mtproto.transport';
import { OutboundService } from './outbound/outbound.service';
import { SendMessageResult, TelegramTransport } from './transport/telegram-transport';

function tempDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-svc-')); }

function makeService(opts: {
  sendResult?: SendMessageResult;
  statusResult?: { status: any; telegramUserId?: string; botUsername?: string; error?: string };
} = {}) {
  const enc = new EncryptionService();
  const accounts = new AccountStoreService(enc);
  const events = new DurableEventStoreService();
  const ingest = { forwardInbound: jest.fn(), emitProviderEvent: jest.fn().mockResolvedValue(undefined) } as unknown as SigcoreIngestService;

  const fakeTransport: TelegramTransport = {
    kind: 'bot',
    sendMessage: jest.fn(async () => opts.sendResult ?? ({ ok: true, status: 'sent', externalMessageId: 'mid-1' } as SendMessageResult)),
    getAccountStatus: jest.fn(async () => opts.statusResult ?? ({ status: 'connected', telegramUserId: '1', botUsername: 'bot' })),
  };
  const transports = {
    forAccount: jest.fn(() => fakeTransport),
  } as unknown as TransportFactory;

  const outbound = new OutboundService(accounts, transports, ingest);
  return { svc: new TelegramService(accounts, events, transports, ingest, outbound), accounts, ingest, fakeTransport };
}

describe('TelegramService', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
    process.env.TELEGRAM_DATA_DIR = dir;
    process.env.TELEGRAM_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString('base64');
    process.env.TELEGRAM_MTPROTO_ENABLED = 'false';
    process.env.TELEGRAM_DRAINER_DISABLED = 'true';
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('refuses to register an mtproto account when feature flag is off', async () => {
    const { svc } = makeService();
    await expect(svc.connectAccount({
      tenantId: 't1', mode: 'mtproto', displayName: 'op', gramjsSession: 'session-bytes',
    })).rejects.toThrow('mtproto_disabled');
  });

  it('refuses to register any account without an encryption key', async () => {
    delete process.env.TELEGRAM_ENCRYPTION_KEY;
    const enc = new EncryptionService();
    const accounts = new AccountStoreService(enc);
    await expect(
      accounts.connect({ tenantId: 't1', mode: 'bot', displayName: 'b', botToken: 'x' } as any),
    ).rejects.toThrow();
  });

  it('connects a bot account, encrypts the token at rest, never exposes it', async () => {
    const { svc, accounts } = makeService();
    const acct = await svc.connectAccount({
      tenantId: 't1', mode: 'bot', displayName: 'bot', botToken: '12345:secret-bot-token',
    });
    expect((acct as any).botTokenEncrypted).toBeUndefined();
    const rec = await accounts.get('t1', acct.id);
    expect(rec!.botTokenEncrypted!.startsWith('v1:')).toBe(true);
    expect(rec!.botTokenEncrypted).not.toContain('secret-bot-token');
    const decrypted = await accounts.getBotToken(rec!);
    expect(decrypted).toBe('12345:secret-bot-token');
  });

  it('returns telegram_account_not_found for a cross-tenant lookup (tenant isolation)', async () => {
    const { svc } = makeService();
    const acct = await svc.connectAccount({
      tenantId: 't1', mode: 'bot', displayName: 'bot', botToken: '12345:token',
    });
    const sameTenant = await svc.getAccountStatus('t1', acct.id);
    const otherTenant = await svc.getAccountStatus('t2', acct.id);
    expect(sameTenant).not.toBeNull();
    expect(otherTenant).toBeNull();
  });

  it('outbound respects tenant isolation', async () => {
    const { svc } = makeService();
    const acct = await svc.connectAccount({
      tenantId: 't1', mode: 'bot', displayName: 'bot', botToken: '12345:token',
    });
    const result = await svc.send({
      tenantId: 't2', accountId: acct.id, telegramChatId: 'c', text: 'hi',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('telegram_account_not_found');
  });

  it('outbound returns ok + externalMessageId on success and is idempotent by key', async () => {
    const { svc, fakeTransport } = makeService();
    const acct = await svc.connectAccount({
      tenantId: 't1', mode: 'bot', displayName: 'bot', botToken: '12345:token',
    });
    const r1 = await svc.send({
      tenantId: 't1', accountId: acct.id, telegramChatId: 'c1', text: 'one', idempotencyKey: 'idem-1',
    });
    const r2 = await svc.send({
      tenantId: 't1', accountId: acct.id, telegramChatId: 'c1', text: 'one', idempotencyKey: 'idem-1',
    });
    expect(r1.ok).toBe(true);
    expect(r2.cached).toBe(true);
    expect(r2.externalMessageId).toBe(r1.externalMessageId);
    expect(fakeTransport.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('outbound failure reports failed status and emits message.failed', async () => {
    const { svc, ingest } = makeService({
      sendResult: { ok: false, status: 'failed', error: 'telegram_send_failed' },
    });
    const acct = await svc.connectAccount({
      tenantId: 't1', mode: 'bot', displayName: 'bot', botToken: '12345:token',
    });
    const r = await svc.send({
      tenantId: 't1', accountId: acct.id, telegramChatId: 'c1', text: 'one',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('telegram_send_failed');
    expect((ingest.emitProviderEvent as jest.Mock).mock.calls.some(
      ([ev]) => ev.eventType === 'message.failed',
    )).toBe(true);
  });

  it('ingestUpdate enqueues an inbound message and dedupes a retry', async () => {
    const { svc } = makeService();
    const acct = await svc.connectAccount({
      tenantId: 't1', mode: 'bot', displayName: 'bot', botToken: '12345:token',
    });
    const update = {
      update_id: 1,
      message: {
        message_id: 7,
        chat: { id: 123, type: 'private' as const },
        from: { id: 99 },
        date: 1700000000,
        text: 'hello',
      },
    };
    const a = await svc.ingestUpdate('t1', acct.id, update as any);
    const b = await svc.ingestUpdate('t1', acct.id, update as any);
    expect(a.status).toBe('enqueued');
    expect(b.status).toBe('duplicate');
  });

  it('ingestUpdate ignores updates targeted at an unknown account (cross-tenant safe)', async () => {
    const { svc } = makeService();
    const acct = await svc.connectAccount({
      tenantId: 't1', mode: 'bot', displayName: 'bot', botToken: '12345:token',
    });
    const r = await svc.ingestUpdate('t2', acct.id, { update_id: 1 } as any);
    expect(r.status).toBe('ignored');
    expect(r.reason).toBe('telegram_account_not_found');
  });

  it('ingestUpdate ignores unsupported attachments instead of crashing', async () => {
    const { svc } = makeService();
    const acct = await svc.connectAccount({
      tenantId: 't1', mode: 'bot', displayName: 'bot', botToken: '12345:token',
    });
    const sticker = {
      update_id: 5,
      message: {
        message_id: 8,
        chat: { id: 555, type: 'private' as const },
        from: { id: 99 },
        date: 1700000001,
        sticker: { file_id: 'sticker-1' },
      },
    };
    const r = await svc.ingestUpdate('t1', acct.id, sticker as any);
    expect(r.status).toBe('enqueued');
  });

  it('listAccounts returns only that tenant\'s records', async () => {
    const { svc } = makeService();
    await svc.connectAccount({ tenantId: 't1', mode: 'bot', displayName: 'b1', botToken: '12345:a' });
    await svc.connectAccount({ tenantId: 't2', mode: 'bot', displayName: 'b2', botToken: '12345:b' });
    expect((await svc.listAccounts('t1')).length).toBe(1);
    expect((await svc.listAccounts('t2')).length).toBe(1);
  });

  it('connectAccount emits provider.account.connected', async () => {
    const { svc, ingest } = makeService();
    await svc.connectAccount({ tenantId: 't1', mode: 'bot', displayName: 'b1', botToken: '12345:a' });
    const events = (ingest.emitProviderEvent as jest.Mock).mock.calls.map(([e]) => e.eventType);
    expect(events).toContain('provider.account.connected');
  });
});
