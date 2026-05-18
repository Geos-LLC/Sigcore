import { EncryptionService, EncryptionUnavailableError } from './encryption.service';

describe('EncryptionService', () => {
  const orig = process.env.TELEGRAM_ENCRYPTION_KEY;

  afterEach(() => {
    if (orig === undefined) delete process.env.TELEGRAM_ENCRYPTION_KEY;
    else process.env.TELEGRAM_ENCRYPTION_KEY = orig;
  });

  it('throws when key is not configured', () => {
    delete process.env.TELEGRAM_ENCRYPTION_KEY;
    const svc = new EncryptionService();
    expect(svc.isReady()).toBe(false);
    expect(() => svc.encrypt('x')).toThrow(EncryptionUnavailableError);
  });

  it('round-trips when configured', () => {
    process.env.TELEGRAM_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    const svc = new EncryptionService();
    expect(svc.isReady()).toBe(true);
    const enc = svc.encrypt('hello-secret');
    expect(enc.startsWith('v1:')).toBe(true);
    expect(enc).not.toContain('hello-secret');
    expect(svc.decrypt(enc)).toBe('hello-secret');
  });

  it('rejects tampered ciphertext', () => {
    process.env.TELEGRAM_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64');
    const svc = new EncryptionService();
    const enc = svc.encrypt('payload');
    // tamper with the last base64 chunk
    const parts = enc.split(':');
    parts[3] = Buffer.from('totally-different-bytes').toString('base64');
    expect(() => svc.decrypt(parts.join(':'))).toThrow();
  });

  it('produces different ciphertext for the same plaintext (IV randomized)', () => {
    process.env.TELEGRAM_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
    const svc = new EncryptionService();
    const a = svc.encrypt('same');
    const b = svc.encrypt('same');
    expect(a).not.toBe(b);
  });
});
