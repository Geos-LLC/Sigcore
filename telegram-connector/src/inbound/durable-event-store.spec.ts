import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DurableEventStoreService } from './durable-event-store.service';
import { NormalizedInboundMessage } from './inbound.types';

function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-events-'));
  return d;
}

function makeNormalized(extras: Partial<NormalizedInboundMessage> = {}): NormalizedInboundMessage {
  return {
    tenantId: 't1',
    accountId: 'a1',
    provider: 'telegram',
    externalMessageId: 'msg-1',
    externalConversationId: 'chat-1',
    participantKey: 'telegram:t1:a1:chat-1',
    direction: 'inbound',
    messageType: 'text',
    text: 'hi',
    timestamp: new Date().toISOString(),
    providerMetadata: {
      provider: 'telegram',
      tenantId: 't1',
      accountId: 'a1',
      telegramChatId: 'chat-1',
    },
    providerPayload: {},
    ...extras,
  };
}

describe('DurableEventStoreService', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
    process.env.TELEGRAM_DATA_DIR = dir;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('enqueues new events and drops duplicates by primary key', async () => {
    const store = new DurableEventStoreService();
    const first = await store.enqueueIfNew(makeNormalized(), 'chat-1:msg-1:0', {});
    expect(first).not.toBeNull();
    const dup = await store.enqueueIfNew(makeNormalized(), 'chat-1:msg-1:0', {});
    expect(dup).toBeNull();
  });

  it('drops duplicates by fallback key when primary differs', async () => {
    const store = new DurableEventStoreService();
    await store.enqueueIfNew(makeNormalized(), 'fallback-A', {});
    const second = await store.enqueueIfNew(
      makeNormalized({ externalMessageId: 'msg-2' }),
      'fallback-A',
      {},
    );
    expect(second).toBeNull();
  });

  it('listReady returns only entries whose nextAttemptAt has elapsed', async () => {
    const store = new DurableEventStoreService();
    const ev = await store.enqueueIfNew(makeNormalized(), 'k1', {});
    expect(ev).not.toBeNull();
    await store.markRetry(ev!, 'temp', 60_000); // schedule into the future
    const ready = await store.listReady(10);
    expect(ready.length).toBe(0);
  });

  it('claim → markSent moves event from pending → sent', async () => {
    const store = new DurableEventStoreService();
    const ev = await store.enqueueIfNew(makeNormalized(), 'k1', {});
    const claimed = await store.claim(ev!);
    expect(claimed!.status).toBe('processing');
    await store.markSent(claimed!);
    const pending = await store.listByStatus('pending');
    const sent = await store.listByStatus('sent');
    expect(pending.length).toBe(0);
    expect(sent.length).toBe(1);
  });

  it('claim → markRetry returns event to pending with bumped attempts', async () => {
    const store = new DurableEventStoreService();
    const ev = await store.enqueueIfNew(makeNormalized(), 'k1', {});
    const claimed = await store.claim(ev!);
    expect(claimed!.attempts).toBe(1);
    await store.markRetry(claimed!, 'sigcore_down', 0);
    const pending = await store.listByStatus('pending');
    expect(pending.length).toBe(1);
    expect(pending[0].lastError).toBe('sigcore_down');
  });

  it('claim → markDead moves event to dead status', async () => {
    const store = new DurableEventStoreService();
    const ev = await store.enqueueIfNew(makeNormalized(), 'k1', {});
    const claimed = await store.claim(ev!);
    await store.markDead(claimed!, 'gave_up');
    const dead = await store.listByStatus('dead');
    expect(dead.length).toBe(1);
    expect(dead[0].lastError).toBe('gave_up');
  });

  it('recovers interrupted processing events on construction', async () => {
    const store = new DurableEventStoreService();
    const ev = await store.enqueueIfNew(makeNormalized(), 'k1', {});
    await store.claim(ev!); // status = processing
    // simulate crash + restart
    const store2 = new DurableEventStoreService();
    const pending = await store2.listByStatus('pending');
    expect(pending.length).toBe(1);
    expect(pending[0].id).toBe(ev!.id);
  });

  it('isolates per-tenant accidentally writing the same external id', async () => {
    const store = new DurableEventStoreService();
    const a = await store.enqueueIfNew(makeNormalized({ tenantId: 't1' }), 'fa', {});
    const b = await store.enqueueIfNew(makeNormalized({ tenantId: 't2' }), 'fb', {});
    // Same externalMessageId but different tenant → both should be accepted
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });
});
