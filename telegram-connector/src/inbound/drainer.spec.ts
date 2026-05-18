import { DrainerService } from './drainer.service';

function buildRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    tenantId: 'ten_1',
    accountId: 'acct_1',
    externalMessageId: 'chat:1',
    externalConversationId: 'chat',
    participantKey: 'telegram:ten_1:acct_1:chat',
    payload: {},
    normalizedPayload: { participantKey: 'telegram:ten_1:acct_1:chat' },
    status: 'processing',
    attempts: 1,
    ...overrides,
  };
}

describe('DrainerService', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.TELEGRAM_DRAINER_MAX_ATTEMPTS = '3';
  });

  it('marks row sent when ingest succeeds', async () => {
    const store = {
      recoverStuckProcessing: jest.fn().mockResolvedValue(0),
      claimBatch: jest.fn().mockResolvedValue([buildRow()]),
      markSent: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn(),
    };
    const ingest = { forwardInbound: jest.fn().mockResolvedValue(undefined) };
    const svc = new DrainerService(store as any, ingest as any);

    const out = await svc.tick();
    expect(ingest.forwardInbound).toHaveBeenCalled();
    expect(store.markSent).toHaveBeenCalledWith('row-1');
    expect(store.markFailed).not.toHaveBeenCalled();
    expect(out.sent).toBe(1);
  });

  it('marks row failed and reschedules when ingest fails (under max attempts)', async () => {
    const store = {
      recoverStuckProcessing: jest.fn().mockResolvedValue(0),
      claimBatch: jest.fn().mockResolvedValue([buildRow({ attempts: 1 })]),
      markSent: jest.fn(),
      markFailed: jest.fn().mockResolvedValue('pending'),
    };
    const ingest = { forwardInbound: jest.fn().mockRejectedValue(new Error('boom')) };
    const svc = new DrainerService(store as any, ingest as any);

    const out = await svc.tick();
    expect(store.markFailed).toHaveBeenCalledWith(
      'row-1',
      'boom',
      expect.objectContaining({ maxAttempts: 3, nextAttemptAt: expect.any(Date) }),
    );
    expect(out.failed).toBe(1);
    expect(out.dead).toBe(0);
  });

  it('moves to dead-letter when markFailed returns dead', async () => {
    const store = {
      recoverStuckProcessing: jest.fn().mockResolvedValue(0),
      claimBatch: jest.fn().mockResolvedValue([buildRow({ attempts: 3 })]),
      markSent: jest.fn(),
      markFailed: jest.fn().mockResolvedValue('dead'),
    };
    const ingest = { forwardInbound: jest.fn().mockRejectedValue(new Error('boom')) };
    const svc = new DrainerService(store as any, ingest as any);

    const out = await svc.tick();
    expect(out.dead).toBe(1);
  });

  it('single-flight: a re-entrant tick is a no-op', async () => {
    const store = {
      recoverStuckProcessing: jest.fn().mockResolvedValue(0),
      claimBatch: jest.fn().mockResolvedValue([]),
      markSent: jest.fn(),
      markFailed: jest.fn(),
    };
    const ingest = { forwardInbound: jest.fn() };
    const svc = new DrainerService(store as any, ingest as any);
    // Pretend a prior tick is in-flight
    (svc as any).running = true;
    const out = await svc.tick();
    expect(out.processed).toBe(0);
    expect(store.claimBatch).not.toHaveBeenCalled();
  });
});
