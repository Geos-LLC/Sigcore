import { OutboundIdempotencyService } from './outbound-idempotency.service';

function buildRepo() {
  return {
    findOne: jest.fn(),
    create: jest.fn((data: any) => ({ id: 'id-1', ...data })),
    save: jest.fn(async (entity: any) => entity),
  };
}

describe('OutboundIdempotencyService', () => {
  it('records a new outbound under (tenant, account, idempotencyKey)', async () => {
    const repo = buildRepo();
    const svc = new OutboundIdempotencyService(repo as any);
    const out = await svc.record({
      tenantId: 't',
      accountId: 'a',
      idempotencyKey: 'k',
      externalMessageId: 'e',
      status: 'sent',
    });
    expect(out.externalMessageId).toBe('e');
    expect(repo.save).toHaveBeenCalled();
  });

  it('resolves duplicate inserts back to the existing row (DB-level uniqueness)', async () => {
    const repo = buildRepo();
    repo.save = jest.fn().mockRejectedValueOnce({ code: '23505' });
    repo.findOne = jest.fn().mockResolvedValueOnce({
      id: 'id-existing',
      tenantId: 't',
      accountId: 'a',
      idempotencyKey: 'k',
      externalMessageId: 'previous',
      status: 'sent',
    });
    const svc = new OutboundIdempotencyService(repo as any);
    const out = await svc.record({
      tenantId: 't',
      accountId: 'a',
      idempotencyKey: 'k',
      externalMessageId: 'shouldnt-overwrite',
      status: 'sent',
    });
    expect(out.id).toBe('id-existing');
    expect(out.externalMessageId).toBe('previous');
  });

  it('looks up by composite key', async () => {
    const repo = buildRepo();
    repo.findOne = jest.fn().mockResolvedValueOnce({ id: 'r' });
    const svc = new OutboundIdempotencyService(repo as any);
    await svc.lookup('t', 'a', 'k');
    expect(repo.findOne).toHaveBeenCalledWith({
      where: { tenantId: 't', accountId: 'a', idempotencyKey: 'k' },
    });
  });
});
