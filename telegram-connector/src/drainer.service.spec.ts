import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DrainerService } from './drainer.service';
import { InboundEventsStore } from './inbound-events.store';
import { EventBusService } from './event-bus.service';
import { SigcoreIngestService } from './sigcore-ingest.service';
import { NormalizedInboundMessage } from './types';

function setup(opts: { maxAttempts?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-drain-'));
  const origCwd = process.cwd();
  process.chdir(dir);
  if (opts.maxAttempts != null) {
    process.env.TELEGRAM_DRAINER_MAX_ATTEMPTS = String(opts.maxAttempts);
  } else {
    delete process.env.TELEGRAM_DRAINER_MAX_ATTEMPTS;
  }
  process.env.TELEGRAM_DRAINER_DISABLED = 'true'; // we drive tick() manually
  const store = new InboundEventsStore();
  const ingest = new SigcoreIngestService();
  const events = new EventBusService();
  const ingested: Array<{ type: string; payload: unknown }> = [];
  const emitted: Array<{ type: string; payload: unknown }> = [];
  (ingest as any).forward = jest.fn(async (type: string, payload: unknown) => {
    ingested.push({ type, payload });
    return { ok: true };
  });
  (events as any).emit = jest.fn(async (type: string, payload: unknown) => {
    emitted.push({ type, payload });
    return { ok: true };
  });
  const drainer = new DrainerService(store, ingest, events);
  return {
    dir, store, ingest, events, drainer, ingested, emitted,
    cleanup: () => {
      process.chdir(origCwd);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function normalized(overrides: Partial<NormalizedInboundMessage> = {}): NormalizedInboundMessage {
  return {
    tenantId: 't',
    accountId: 'a',
    provider: 'telegram',
    externalMessageId: '1:42',
    externalConversationId: '1',
    participantKey: 'telegram:t:a:1',
    participant: { provider: 'telegram', telegramChatId: '1', accountId: 'a', tenantId: 't' },
    direction: 'inbound',
    messageType: 'text',
    text: 'hi',
    timestamp: new Date(1700000000_000).toISOString(),
    providerPayload: {},
    ...overrides,
  };
}

describe('DrainerService', () => {
  let h: ReturnType<typeof setup>;
  afterEach(() => h?.cleanup());

  it('drains pending events through Sigcore and emits message.received + conversation.updated', async () => {
    h = setup();
    h.store.enqueue(normalized(), {});
    const stats = await h.drainer.tick();
    expect(stats.processed).toBe(1);
    expect(stats.sent).toBe(1);
    expect(h.ingested).toHaveLength(1);
    expect(h.ingested[0].type).toBe('message_inbound');
    const emittedTypes = h.emitted.map(e => e.type);
    expect(emittedTypes).toContain('message.received');
    expect(emittedTypes).toContain('conversation.updated');
  });

  it('retries on transient ingest failure without losing the event', async () => {
    h = setup({ maxAttempts: 3 });
    (h.ingest as any).forward = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'http_500' })
      .mockResolvedValueOnce({ ok: true });
    const { record } = h.store.enqueue(normalized(), {});

    // First tick fails transiently
    const first = await h.drainer.tick();
    expect(first.sent).toBe(0);
    expect(first.failed).toBe(1);
    expect(first.dead).toBe(0);
    expect(h.store.get(record.id)!.status).toBe('pending');
    expect(h.store.get(record.id)!.attempts).toBe(1);

    // Jump past back-off and tick again — the second forward succeeds
    const realNow = Date.now;
    Date.now = () => realNow() + 5 * 60_000;
    try {
      const second = await h.drainer.tick();
      expect(second.sent).toBe(1);
    } finally {
      Date.now = realNow;
    }
    expect(h.store.get(record.id)!.status).toBe('sent');
  });

  it('dead-letters after maxAttempts and emits message.failed terminal', async () => {
    h = setup({ maxAttempts: 2 });
    (h.ingest as any).forward = jest.fn().mockResolvedValue({ ok: false, error: 'http_500' });
    h.store.enqueue(normalized(), {});

    // First attempt fails — pending with attempts=1
    await h.drainer.tick();
    expect(h.store.countByStatus().pending).toBe(1);

    // Future tick — second attempt should dead-letter (attempts hits 2 → cap)
    const realNow = Date.now;
    Date.now = () => realNow() + 5 * 60_000; // jump past back-off
    try {
      const stats = await h.drainer.tick();
      expect(stats.dead).toBe(1);
    } finally {
      Date.now = realNow;
    }
    expect(h.store.countByStatus().dead).toBe(1);
    const failed = h.emitted.filter(e => e.type === 'message.failed');
    expect(failed).toHaveLength(1);
    expect((failed[0].payload as any).data.terminal).toBe(true);
  });

  it('does not double-drain when tick is called concurrently', async () => {
    h = setup();
    h.store.enqueue(normalized(), {});
    h.store.enqueue(normalized({ externalMessageId: '1:43' }), {});
    const [r1, r2] = await Promise.all([h.drainer.tick(), h.drainer.tick()]);
    const total = r1.processed + r2.processed;
    expect(total).toBe(2);
    // The second concurrent call should return zero — the in-flight guard
    // (`this.running`) prevents overlapping passes.
    expect(r1.processed === 0 || r2.processed === 0).toBe(true);
  });
});
