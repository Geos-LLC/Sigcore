import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { InboundEventsStore } from './inbound-events.store';
import { NormalizedInboundMessage } from './types';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-events-'));
  const origCwd = process.cwd();
  process.chdir(dir);
  return { dir, cleanup: () => { process.chdir(origCwd); fs.rmSync(dir, { recursive: true, force: true }); } };
}

function normalized(overrides: Partial<NormalizedInboundMessage> = {}): NormalizedInboundMessage {
  return {
    tenantId: 't',
    accountId: 'a',
    provider: 'telegram',
    externalMessageId: '1:42',
    externalConversationId: '1',
    participantKey: 'telegram:t:a:1',
    participant: {
      provider: 'telegram', telegramChatId: '1', accountId: 'a', tenantId: 't',
    },
    direction: 'inbound',
    messageType: 'text',
    text: 'hi',
    timestamp: new Date(1700000000_000).toISOString(),
    providerPayload: {},
    ...overrides,
  };
}

describe('InboundEventsStore', () => {
  let env: ReturnType<typeof setup>;
  beforeEach(() => { env = setup(); });
  afterEach(() => env.cleanup());

  it('enqueues a new normalized event in status=pending', () => {
    const s = new InboundEventsStore();
    const { enqueued, record } = s.enqueue(normalized(), { update_id: 1 });
    expect(enqueued).toBe(true);
    expect(record.status).toBe('pending');
    expect(record.attempts).toBe(0);
    expect(record.lastError).toBeUndefined();
  });

  it('treats repeated externalMessageId for same tenant+account as duplicate', () => {
    const s = new InboundEventsStore();
    const a = s.enqueue(normalized(), { update_id: 1 });
    const b = s.enqueue(normalized(), { update_id: 1 });
    expect(a.enqueued).toBe(true);
    expect(b.enqueued).toBe(false);
    expect(b.record.id).toBe(a.record.id);
  });

  it('claims pending events and transitions them to processing', () => {
    const s = new InboundEventsStore();
    s.enqueue(normalized({ externalMessageId: '1:1' }), {});
    s.enqueue(normalized({ externalMessageId: '1:2' }), {});
    const claimed = s.claimBatch(10);
    expect(claimed).toHaveLength(2);
    for (const c of claimed) {
      expect(c.status).toBe('processing');
      expect(c.attempts).toBe(1);
    }
    // A second claim returns nothing because both are already processing.
    expect(s.claimBatch(10)).toHaveLength(0);
  });

  it('marks an event sent and clears lastError', () => {
    const s = new InboundEventsStore();
    const { record } = s.enqueue(normalized(), {});
    const [claimed] = s.claimBatch(10);
    s.markFailed(claimed.id, 'http_500', 5, 10);
    // Re-claim, then mark sent.
    const [re] = s.claimBatch(10, new Date(Date.now() + 1000));
    s.markSent(re.id);
    expect(s.get(record.id)!.status).toBe('sent');
    expect(s.get(record.id)!.lastError).toBeUndefined();
  });

  it('dead-letters after maxAttempts', () => {
    const s = new InboundEventsStore();
    const { record } = s.enqueue(normalized(), {});

    // First attempt
    let claimed = s.claimBatch(10);
    expect(claimed).toHaveLength(1);
    s.markFailed(claimed[0].id, 'boom', 2, 0);
    expect(s.get(record.id)!.status).toBe('pending');
    expect(s.get(record.id)!.attempts).toBe(1);

    // Second attempt — hits the cap, dead-letter.
    claimed = s.claimBatch(10, new Date(Date.now() + 5_000));
    expect(claimed).toHaveLength(1);
    s.markFailed(claimed[0].id, 'boom_again', 2, 0);
    const final = s.get(record.id)!;
    expect(final.status).toBe('dead');
    expect(final.attempts).toBe(2);
    expect(final.lastError).toBe('boom_again');
  });

  it('honors back-off — claimed batch is empty while nextAttemptAt is in the future', () => {
    const s = new InboundEventsStore();
    s.enqueue(normalized(), {});
    let [claimed] = s.claimBatch(10);
    s.markFailed(claimed.id, 'transient', 5, 60_000);
    // Immediate re-claim is blocked by back-off.
    expect(s.claimBatch(10)).toHaveLength(0);
    // Future tick lets it through again.
    expect(s.claimBatch(10, new Date(Date.now() + 120_000))).toHaveLength(1);
  });

  it('persists status transitions across instances (durability)', () => {
    const s1 = new InboundEventsStore();
    s1.enqueue(normalized(), { update_id: 1 });

    const s2 = new InboundEventsStore();
    // Same data dir → second instance sees the enqueued event.
    expect(s2.countByStatus().pending).toBe(1);
  });

  it('lists dead-lettered events scoped to tenant', () => {
    const s = new InboundEventsStore();
    s.enqueue(normalized({ tenantId: 't1' }), {});
    s.enqueue(normalized({ tenantId: 't2', externalMessageId: '2:1' }), {});
    // Burn both to dead with maxAttempts=1.
    for (const c of s.claimBatch(10)) s.markFailed(c.id, 'x', 1, 0);
    expect(s.listDead()).toHaveLength(2);
    expect(s.listDead('t1')).toHaveLength(1);
    expect(s.listDead('t1')[0].tenantId).toBe('t1');
  });
});
