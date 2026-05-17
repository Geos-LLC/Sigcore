import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { AccountStoreService } from './account-store.service';
import { DedupeService } from './dedupe.service';
import { EncryptionService } from './encryption.service';
import { SigcoreIngestService } from './sigcore-ingest.service';
import { TelegramService } from './telegram.service';
import { TelegramBotUpdate } from './types';

// Test harness: isolate persistence per spec to a tmp cwd, set a real
// encryption key, and stub the network-dependent pieces.
function bootstrap() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-connector-test-'));
  const origCwd = process.cwd();
  process.chdir(tmpDir);

  process.env.TELEGRAM_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

  const enc = new EncryptionService();
  const store = new AccountStoreService(enc);
  const dedupe = new DedupeService();
  const ingest = new SigcoreIngestService();
  // Stub the network: capture forwarded payloads in memory.
  const forwarded: Array<{ eventType: string; event: unknown }> = [];
  (ingest as any).forward = jest.fn(async (eventType: string, event: unknown) => {
    forwarded.push({ eventType, event });
    return { ok: true };
  });
  const svc = new TelegramService(store, dedupe, ingest);

  return {
    svc,
    store,
    dedupe,
    ingest,
    forwarded,
    cleanup: () => {
      process.chdir(origCwd);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function update(message: Partial<TelegramBotUpdate['message']> & { chat: { id: number; type: any }; message_id: number; date: number }): TelegramBotUpdate {
  return { update_id: Math.floor(Math.random() * 1e6), message: message as any };
}

describe('TelegramService — inbound', () => {
  let h: ReturnType<typeof bootstrap>;
  beforeEach(() => { h = bootstrap(); });
  afterEach(() => h.cleanup());

  it('normalizes and forwards an inbound text message to Sigcore', async () => {
    // Seed an account directly via the store so we don't hit the live Bot API.
    const acc = h.store.connect({
      tenantId: 't1',
      mode: 'bot',
      displayName: 'Test bot',
      botToken: '1234567890:AAA1BBB2CCC3DDD4EEE5FFF6GGG7HHH8III99',
      botUsername: 'test_bot',
    });

    const result = await h.svc.handleInbound(
      update({
        message_id: 1,
        date: 1700000000,
        chat: { id: 555, type: 'private' },
        from: { id: 555, is_bot: false, first_name: 'Alex' } as any,
        text: 'hi',
      }),
      { tenantId: 't1', accountId: acc.id },
    );
    expect(result.ok).toBe(true);
    expect(result.forwarded).toBe(true);
    expect(h.forwarded).toHaveLength(1);
    expect(h.forwarded[0].eventType).toBe('message_inbound');
    expect((h.forwarded[0].event as any).text).toBe('hi');
  });

  it('deduplicates identical webhook deliveries', async () => {
    const acc = h.store.connect({
      tenantId: 't1', mode: 'bot', displayName: 'b',
      botToken: '1234567890:AAA1BBB2CCC3DDD4EEE5FFF6GGG7HHH8III99',
    });
    const u = update({
      message_id: 7, date: 1700000000,
      chat: { id: 1, type: 'private' }, text: 'once',
    });
    const a = await h.svc.handleInbound(u, { tenantId: 't1', accountId: acc.id });
    const b = await h.svc.handleInbound(u, { tenantId: 't1', accountId: acc.id });
    expect(a.forwarded).toBe(true);
    expect(b.deduped).toBe(true);
    expect(h.forwarded).toHaveLength(1);
  });

  it('does not crash on unsupported attachment (sticker)', async () => {
    const acc = h.store.connect({
      tenantId: 't1', mode: 'bot', displayName: 'b',
      botToken: '1234567890:AAA1BBB2CCC3DDD4EEE5FFF6GGG7HHH8III99',
    });
    const result = await h.svc.handleInbound(
      update({
        message_id: 9, date: 1700000200,
        chat: { id: 1, type: 'private' },
        sticker: { file_id: 'sx' } as any,
      }),
      { tenantId: 't1', accountId: acc.id },
    );
    expect(result.ok).toBe(true);
    expect((h.forwarded[0].event as any).messageType).toBe('unknown');
  });
});

describe('TelegramService — tenant isolation', () => {
  let h: ReturnType<typeof bootstrap>;
  beforeEach(() => { h = bootstrap(); });
  afterEach(() => h.cleanup());

  it('rejects outbound sends that target another tenant\'s account', async () => {
    const tenantA = h.store.connect({
      tenantId: 'tenant_a', mode: 'bot', displayName: 'a',
      botToken: '1234567890:AAA1BBB2CCC3DDD4EEE5FFF6GGG7HHH8III99',
    });
    await expect(
      h.svc.sendMessage({
        tenantId: 'tenant_b', // wrong tenant
        accountId: tenantA.id,
        telegramChatId: '999',
        text: 'hi',
      }),
    ).rejects.toThrow(/telegram_account_not_found/);
  });

  it('rejects access to an unknown account id', () => {
    expect(() =>
      h.svc.getAccountStatus('tenant_a', 'acct_does_not_exist'),
    ).toThrow(/telegram_account_not_found/);
  });
});

describe('TelegramService — outbound', () => {
  let h: ReturnType<typeof bootstrap>;
  beforeEach(() => { h = bootstrap(); });
  afterEach(() => h.cleanup());

  it('returns failed with status when account is in error state', async () => {
    const acc = h.store.connect({
      tenantId: 't', mode: 'bot', displayName: 'b',
      botToken: '1234567890:AAA1BBB2CCC3DDD4EEE5FFF6GGG7HHH8III99',
    });
    h.store.setStatus(acc.id, 'expired', 'token_revoked');
    const res = await h.svc.sendMessage({
      tenantId: 't', accountId: acc.id, telegramChatId: '1', text: 'x',
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(res.error).toBe('account_expired');
  });

  it('blocks mtproto outbound until Phase 4 is implemented', async () => {
    const acc = h.store.connect({
      tenantId: 't', mode: 'mtproto', displayName: 'u',
      gramjsSession: 'session-blob',
    });
    const res = await h.svc.sendMessage({
      tenantId: 't', accountId: acc.id, telegramChatId: '1', text: 'x',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('mtproto_outbound_not_implemented');
  });

  it('treats repeated idempotencyKey as queued without re-sending', async () => {
    const acc = h.store.connect({
      tenantId: 't', mode: 'bot', displayName: 'b',
      botToken: '1234567890:AAA1BBB2CCC3DDD4EEE5FFF6GGG7HHH8III99',
    });
    // Mock the Bot API client by stubbing axios used inside it.
    const axios = require('axios');
    const spy = jest.spyOn(axios, 'post').mockResolvedValue({
      data: { ok: true, result: { message_id: 7 } },
    } as any);

    const first = await h.svc.sendMessage({
      tenantId: 't', accountId: acc.id, telegramChatId: '99',
      text: 'hi', idempotencyKey: 'idem-1',
    });
    const second = await h.svc.sendMessage({
      tenantId: 't', accountId: acc.id, telegramChatId: '99',
      text: 'hi', idempotencyKey: 'idem-1',
    });
    expect(first.status).toBe('sent');
    expect(second.status).toBe('queued');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('TelegramService — ingestion retry on Sigcore failure', () => {
  it('reports forwarded=false when Sigcore ingest fails, leaving caller to retry', async () => {
    const h = bootstrap();
    try {
      (h.ingest as any).forward = jest.fn().mockResolvedValue({ ok: false, error: 'http_500' });
      const acc = h.store.connect({
        tenantId: 't', mode: 'bot', displayName: 'b',
        botToken: '1234567890:AAA1BBB2CCC3DDD4EEE5FFF6GGG7HHH8III99',
      });
      const result = await h.svc.handleInbound(
        update({ message_id: 1, date: 1700000000, chat: { id: 1, type: 'private' }, text: 'x' }),
        { tenantId: 't', accountId: acc.id },
      );
      expect(result.ok).toBe(false);
      expect(result.forwarded).toBe(false);
      expect(result.reason).toBe('http_500');
    } finally {
      h.cleanup();
    }
  });
});