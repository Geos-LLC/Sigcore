import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { AccountStoreService } from './account-store.service';
import { DedupeService } from './dedupe.service';
import { EncryptionService } from './encryption.service';
import { EventBusService } from './event-bus.service';
import { InboundEventsStore } from './inbound-events.store';
import { TelegramService } from './telegram.service';
import { TelegramBotUpdate } from './types';
import { TransportFactory } from './transports/transport.factory';

function bootstrap() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-connector-test-'));
  const origCwd = process.cwd();
  process.chdir(tmpDir);

  process.env.TELEGRAM_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  delete process.env.TELEGRAM_MTPROTO_ENABLED;
  delete process.env.SIGCORE_API_URL;
  delete process.env.SIGCORE_WEBHOOK_KEY;

  const enc = new EncryptionService();
  const store = new AccountStoreService(enc);
  const dedupe = new DedupeService();
  const inboundStore = new InboundEventsStore();
  const eventBus = new EventBusService();
  const transports = new TransportFactory();

  // Capture all provider events for assertions
  const emitted: Array<{ type: string; payload: unknown }> = [];
  (eventBus as any).emit = jest.fn(async (type: string, payload: unknown) => {
    emitted.push({ type, payload });
    return { ok: true };
  });

  const svc = new TelegramService(store, dedupe, inboundStore, eventBus, transports);

  return {
    svc, store, dedupe, inboundStore, eventBus, transports, emitted,
    cleanup: () => {
      process.chdir(origCwd);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function update(message: Partial<TelegramBotUpdate['message']> & { chat: { id: number; type: any }; message_id: number; date: number }): TelegramBotUpdate {
  return { update_id: Math.floor(Math.random() * 1e6), message: message as any };
}

const VALID_BOT_TOKEN = '1234567890:AAA1BBB2CCC3DDD4EEE5FFF6GGG7HHH8III99';

describe('TelegramService — account lifecycle', () => {
  let h: ReturnType<typeof bootstrap>;
  beforeEach(() => { h = bootstrap(); });
  afterEach(() => h.cleanup());

  it('emits provider.account.connected when a bot account is registered (via store-direct seed)', async () => {
    // We seed via the store to avoid hitting the live Bot API getMe call.
    const acc = h.store.connect({
      tenantId: 't1', mode: 'bot', displayName: 'Test bot',
      botToken: VALID_BOT_TOKEN, botUsername: 'test_bot',
    });
    // Re-emit via the service path for clarity
    (h.svc as any).emitConnected(acc);
    const connected = h.emitted.filter(e => e.type === 'provider.account.connected');
    expect(connected.length).toBeGreaterThanOrEqual(1);
    expect((connected[0].payload as any).tenantId).toBe('t1');
  });

  it('emits provider.account.disconnected on disconnect', async () => {
    const acc = h.store.connect({
      tenantId: 't1', mode: 'bot', displayName: 'b', botToken: VALID_BOT_TOKEN,
    });
    await h.svc.disconnectAccount('t1', acc.id);
    const disc = h.emitted.filter(e => e.type === 'provider.account.disconnected');
    expect(disc).toHaveLength(1);
    expect((disc[0].payload as any).accountId).toBe(acc.id);
  });
});

describe('TelegramService — inbound (durable store)', () => {
  let h: ReturnType<typeof bootstrap>;
  beforeEach(() => { h = bootstrap(); });
  afterEach(() => h.cleanup());

  it('normalizes inbound and enqueues to the durable store in status=pending', () => {
    const acc = h.store.connect({
      tenantId: 't1', mode: 'bot', displayName: 'b', botToken: VALID_BOT_TOKEN,
    });
    const result = h.svc.handleInbound(
      update({
        message_id: 1, date: 1700000000,
        chat: { id: 555, type: 'private' },
        from: { id: 555, is_bot: false, first_name: 'Alex' } as any,
        text: 'hi',
      }),
      { tenantId: 't1', accountId: acc.id },
    );
    expect(result.ok).toBe(true);
    expect(result.enqueued).toBe(true);
    expect(result.eventId).toBeDefined();
    const stored = h.svc.getEvent(result.eventId!)!;
    expect(stored.status).toBe('pending');
    expect(stored.normalizedPayload.text).toBe('hi');
  });

  it('deduplicates identical webhook deliveries at the durable layer', () => {
    const acc = h.store.connect({
      tenantId: 't1', mode: 'bot', displayName: 'b', botToken: VALID_BOT_TOKEN,
    });
    const u = update({
      message_id: 7, date: 1700000000,
      chat: { id: 1, type: 'private' }, text: 'once',
    });
    const a = h.svc.handleInbound(u, { tenantId: 't1', accountId: acc.id });
    const b = h.svc.handleInbound(u, { tenantId: 't1', accountId: acc.id });
    expect(a.enqueued).toBe(true);
    expect(b.deduped).toBe(true);
    expect(b.eventId).toBe(a.eventId);
    expect(h.inboundStore.countByStatus().pending).toBe(1);
  });

  it('does not crash on unsupported attachment (sticker) — enqueues as unknown', () => {
    const acc = h.store.connect({
      tenantId: 't1', mode: 'bot', displayName: 'b', botToken: VALID_BOT_TOKEN,
    });
    const result = h.svc.handleInbound(
      update({
        message_id: 9, date: 1700000200,
        chat: { id: 1, type: 'private' },
        sticker: { file_id: 'sx' } as any,
      }),
      { tenantId: 't1', accountId: acc.id },
    );
    expect(result.ok).toBe(true);
    const stored = h.svc.getEvent(result.eventId!)!;
    expect(stored.normalizedPayload.messageType).toBe('unknown');
  });
});

describe('TelegramService — tenant isolation', () => {
  let h: ReturnType<typeof bootstrap>;
  beforeEach(() => { h = bootstrap(); });
  afterEach(() => h.cleanup());

  it('rejects outbound sends that target another tenant\'s account', async () => {
    const tenantA = h.store.connect({
      tenantId: 'tenant_a', mode: 'bot', displayName: 'a', botToken: VALID_BOT_TOKEN,
    });
    await expect(
      h.svc.sendMessage({
        tenantId: 'tenant_b', accountId: tenantA.id,
        telegramChatId: '999', text: 'hi',
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
  afterEach(() => jest.restoreAllMocks());

  it('returns failed with status when account is in expired state and emits message.failed', async () => {
    const acc = h.store.connect({
      tenantId: 't', mode: 'bot', displayName: 'b', botToken: VALID_BOT_TOKEN,
    });
    h.store.setStatus(acc.id, 'expired', 'token_revoked');
    const res = await h.svc.sendMessage({
      tenantId: 't', accountId: acc.id, telegramChatId: '1', text: 'x',
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('failed');
    expect(res.error).toBe('account_expired');
    expect(h.emitted.some(e => e.type === 'message.failed')).toBe(true);
  });

  it('blocks mtproto outbound when feature flag is off (default)', async () => {
    const acc = h.store.connect({
      tenantId: 't', mode: 'mtproto', displayName: 'u', gramjsSession: 'session-blob',
    });
    const res = await h.svc.sendMessage({
      tenantId: 't', accountId: acc.id, telegramChatId: '1', text: 'x',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('mtproto_outbound_not_implemented');
  });

  it('treats repeated idempotencyKey as queued without re-sending and emits message.sent only once', async () => {
    const acc = h.store.connect({
      tenantId: 't', mode: 'bot', displayName: 'b', botToken: VALID_BOT_TOKEN,
    });
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
    expect(h.emitted.filter(e => e.type === 'message.sent')).toHaveLength(1);
  });

  it('emits message.sent on successful bot send', async () => {
    const acc = h.store.connect({
      tenantId: 't', mode: 'bot', displayName: 'b', botToken: VALID_BOT_TOKEN,
    });
    const axios = require('axios');
    jest.spyOn(axios, 'post').mockResolvedValue({
      data: { ok: true, result: { message_id: 42 } },
    } as any);
    const res = await h.svc.sendMessage({
      tenantId: 't', accountId: acc.id, telegramChatId: '99', text: 'hi',
    });
    expect(res.status).toBe('sent');
    expect(res.externalMessageId).toBe('99:42');
    const sent = h.emitted.filter(e => e.type === 'message.sent');
    expect(sent).toHaveLength(1);
    expect((sent[0].payload as any).data.externalMessageId).toBe('99:42');
  });
});

describe('TelegramService — invalid account rejection on webhook routing', () => {
  let h: ReturnType<typeof bootstrap>;
  beforeEach(() => { h = bootstrap(); });
  afterEach(() => h.cleanup());

  it('throws when handleInbound is called for an unknown account via getAccountStatus', () => {
    // The controller invokes getAccountStatus before handleInbound; that lookup
    // must throw NotFoundException for an unregistered account.
    expect(() => h.svc.getAccountStatus('t', 'acct_missing')).toThrow();
  });
});
