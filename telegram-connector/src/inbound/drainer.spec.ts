import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DurableEventStoreService } from './durable-event-store.service';
import { DrainerService } from './drainer.service';
import { SigcoreIngestService } from '../events/sigcore-ingest.service';
import { NormalizedInboundMessage } from './inbound.types';

class FakeIngest {
  forwarded: NormalizedInboundMessage[] = [];
  emitted: any[] = [];
  failNextN = 0;
  async forwardInbound(message: NormalizedInboundMessage): Promise<void> {
    if (this.failNextN > 0) {
      this.failNextN--;
      throw new Error('sigcore_down');
    }
    this.forwarded.push(message);
  }
  async emitProviderEvent(ev: any): Promise<void> {
    this.emitted.push(ev);
  }
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tg-drainer-'));
}

function makeNormalized(extId = 'm1'): NormalizedInboundMessage {
  return {
    tenantId: 't1',
    accountId: 'a1',
    provider: 'telegram',
    externalMessageId: extId,
    externalConversationId: 'chat',
    participantKey: `telegram:t1:a1:chat`,
    direction: 'inbound',
    messageType: 'text',
    text: 'hi',
    timestamp: new Date().toISOString(),
    providerMetadata: { provider: 'telegram', tenantId: 't1', accountId: 'a1', telegramChatId: 'chat' },
    providerPayload: {},
  };
}

describe('DrainerService', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
    process.env.TELEGRAM_DATA_DIR = dir;
    process.env.TELEGRAM_DRAINER_DISABLED = 'true'; // manual ticks
    process.env.TELEGRAM_DRAINER_MAX_ATTEMPTS = '3';
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('forwards pending events and marks sent + emits message.received', async () => {
    const store = new DurableEventStoreService();
    const ingest = new FakeIngest();
    const drainer = new DrainerService(store, ingest as unknown as SigcoreIngestService);

    await store.enqueueIfNew(makeNormalized('m1'), 'fb', {});
    await drainer.tick();

    expect(ingest.forwarded.length).toBe(1);
    expect(ingest.emitted.find((e) => e.eventType === 'message.received')).toBeTruthy();
    const sent = await store.listByStatus('sent');
    expect(sent.length).toBe(1);
  });

  it('retries on transient failure (back-off scheduled, still pending)', async () => {
    const store = new DurableEventStoreService();
    const ingest = new FakeIngest();
    ingest.failNextN = 1;
    const drainer = new DrainerService(store, ingest as unknown as SigcoreIngestService);

    await store.enqueueIfNew(makeNormalized('m1'), 'fb', {});
    await drainer.tick();

    const pending = await store.listByStatus('pending');
    expect(pending.length).toBe(1);
    expect(pending[0].attempts).toBe(1);
    expect(pending[0].lastError).toBe('sigcore_down');
  });

  it('moves to dead after max attempts and emits terminal message.failed', async () => {
    process.env.TELEGRAM_DRAINER_MAX_ATTEMPTS = '2';
    const store = new DurableEventStoreService();
    const ingest = new FakeIngest();
    ingest.failNextN = 10;
    const drainer = new DrainerService(store, ingest as unknown as SigcoreIngestService);

    await store.enqueueIfNew(makeNormalized('m1'), 'fb', {});

    // Move nextAttemptAt back into the past between ticks so retries fire.
    const tickAndClock = async () => {
      const pendingFirst = await store.listByStatus('pending');
      for (const p of pendingFirst) {
        p.nextAttemptAt = new Date(0).toISOString();
        await store.markRetry(p, p.lastError || '', -1);
      }
      await drainer.tick();
    };

    await drainer.tick(); // attempt 1
    await tickAndClock(); // attempt 2 → dead
    await tickAndClock(); // no-op, already dead

    const dead = await store.listByStatus('dead');
    expect(dead.length).toBe(1);
    const terminal = ingest.emitted.find((e) => e.eventType === 'message.failed' && e.data?.terminal === true);
    expect(terminal).toBeTruthy();
  });

  it('skips overlapping ticks (single-flight)', async () => {
    const store = new DurableEventStoreService();
    const ingest = new FakeIngest();
    const drainer = new DrainerService(store, ingest as unknown as SigcoreIngestService);

    await store.enqueueIfNew(makeNormalized('m1'), 'fb', {});
    // Force the running flag manually to simulate an overlapping tick
    (drainer as any).running = true;
    await drainer.tick();
    expect(ingest.forwarded.length).toBe(0);
    (drainer as any).running = false;
    await drainer.tick();
    expect(ingest.forwarded.length).toBe(1);
  });
});
