import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BotTransport } from './bot.transport';
import { AccountStoreService } from '../accounts/account-store.service';
import { EncryptionService } from '../common/encryption.service';
import { TelegramBotApiClient } from './telegram-bot-api.client';

function tempDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-bot-')); }

describe('BotTransport', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
    process.env.TELEGRAM_DATA_DIR = dir;
    process.env.TELEGRAM_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString('base64');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('sends a message and returns the Telegram message id', async () => {
    const enc = new EncryptionService();
    const accounts = new AccountStoreService(enc);
    const fakeClient = {
      sendMessage: jest.fn(async () => ({ ok: true, result: { message_id: 555, date: 1 } })),
      getMe: jest.fn(),
    } as unknown as TelegramBotApiClient;
    const transport = new BotTransport(accounts, () => fakeClient);
    const acct = await accounts.connect({ tenantId: 't1', mode: 'bot', displayName: 'b', botToken: '12345:tok' });

    const result = await transport.sendMessage({ account: acct, telegramChatId: '888', text: 'hi' });
    expect(result.ok).toBe(true);
    expect(result.externalMessageId).toBe('555');
    expect(fakeClient.sendMessage).toHaveBeenCalledWith('888', 'hi');
  });

  it('reports failed when Telegram returns ok=false', async () => {
    const enc = new EncryptionService();
    const accounts = new AccountStoreService(enc);
    const fakeClient = {
      sendMessage: jest.fn(async () => ({ ok: false, description: 'chat not found' })),
      getMe: jest.fn(),
    } as unknown as TelegramBotApiClient;
    const transport = new BotTransport(accounts, () => fakeClient);
    const acct = await accounts.connect({ tenantId: 't1', mode: 'bot', displayName: 'b', botToken: '12345:tok' });

    const result = await transport.sendMessage({ account: acct, telegramChatId: '888', text: 'hi' });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('chat not found');
  });

  it('refuses mtproto accounts', async () => {
    const enc = new EncryptionService();
    const accounts = new AccountStoreService(enc);
    const transport = new BotTransport(accounts, () => ({} as TelegramBotApiClient));
    const acct = await accounts.connect({ tenantId: 't1', mode: 'mtproto', displayName: 'op', gramjsSession: 'sess' });
    const result = await transport.sendMessage({ account: acct, telegramChatId: '1', text: 'x' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('wrong_transport');
  });
});
