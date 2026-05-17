import axios from 'axios';
import { EventBusService } from './event-bus.service';

describe('EventBusService', () => {
  const original = {
    SIGCORE_API_URL: process.env.SIGCORE_API_URL,
    SIGCORE_WEBHOOK_KEY: process.env.SIGCORE_WEBHOOK_KEY,
  };
  afterEach(() => {
    process.env.SIGCORE_API_URL = original.SIGCORE_API_URL ?? '';
    process.env.SIGCORE_WEBHOOK_KEY = original.SIGCORE_WEBHOOK_KEY ?? '';
    jest.restoreAllMocks();
  });

  it('skips emit when Sigcore is not configured', async () => {
    delete process.env.SIGCORE_API_URL;
    delete process.env.SIGCORE_WEBHOOK_KEY;
    const bus = new EventBusService();
    const res = await bus.emit('message.received', { tenantId: 't', data: {} });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('not_configured');
  });

  it('posts a typed provider event to /webhooks/telegram/provider-events', async () => {
    process.env.SIGCORE_API_URL = 'http://sigcore.test/api';
    process.env.SIGCORE_WEBHOOK_KEY = 'k';
    const spy = jest.spyOn(axios, 'post').mockResolvedValue({ data: {} } as any);
    const bus = new EventBusService();
    await bus.emit('provider.account.connected', {
      tenantId: 't1',
      accountId: 'acct_1',
      data: { mode: 'bot' },
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, body, opts] = spy.mock.calls[0];
    expect(url).toBe('http://sigcore.test/api/webhooks/telegram/provider-events');
    expect((body as any).type).toBe('provider.account.connected');
    expect((body as any).tenantId).toBe('t1');
    expect((body as any).accountId).toBe('acct_1');
    expect((opts as any).headers['x-webhook-key']).toBe('k');
  });

  it('returns ok=false on network failure but does not throw', async () => {
    process.env.SIGCORE_API_URL = 'http://sigcore.test/api';
    process.env.SIGCORE_WEBHOOK_KEY = 'k';
    jest.spyOn(axios, 'post').mockRejectedValue(new Error('econnrefused'));
    const bus = new EventBusService();
    const res = await bus.emit('message.failed', { tenantId: 't', data: {} });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('econnrefused');
  });
});
