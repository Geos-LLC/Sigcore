import { VerifyCache } from './verify-cache.service';

describe('VerifyCache', () => {
  let cache: VerifyCache;

  beforeEach(() => {
    delete process.env.TELEGRAM_VERIFY_CACHE_TTL_MS;
    delete process.env.TELEGRAM_VERIFY_CACHE_MAX_ENTRIES;
    cache = new VerifyCache();
  });

  it('returns null on miss', () => {
    expect(cache.get('ws1', '@foo')).toBeNull();
  });

  it('stores + returns verdict on hit, case-insensitive chatRef', () => {
    const verdict = { status: 'ready', warnings: [] };
    cache.set('ws1', '@FooChannel', verdict);
    expect(cache.get('ws1', '@foochannel')).toEqual(verdict);
  });

  it('expires entries after TTL', () => {
    process.env.TELEGRAM_VERIFY_CACHE_TTL_MS = '50';
    const c = new VerifyCache();
    c.set('ws1', '@foo', { status: 'ready' });
    expect(c.get('ws1', '@foo')).not.toBeNull();
    return new Promise((resolve) => {
      setTimeout(() => {
        expect(c.get('ws1', '@foo')).toBeNull();
        resolve(undefined);
      }, 80);
    });
  });

  it('FIFO-evicts when over max', () => {
    process.env.TELEGRAM_VERIFY_CACHE_MAX_ENTRIES = '3';
    const c = new VerifyCache();
    c.set('ws1', '@a', { v: 1 });
    c.set('ws1', '@b', { v: 2 });
    c.set('ws1', '@c', { v: 3 });
    c.set('ws1', '@d', { v: 4 }); // evicts @a
    expect(c.get('ws1', '@a')).toBeNull();
    expect(c.get('ws1', '@d')).toEqual({ v: 4 });
    expect(c.size()).toBe(3);
  });

  it('scopes by workspaceId', () => {
    cache.set('ws1', '@foo', { v: 1 });
    expect(cache.get('ws2', '@foo')).toBeNull();
  });
});
