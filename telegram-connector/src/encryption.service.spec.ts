import * as crypto from 'crypto';
import { EncryptionService } from './encryption.service';

describe('EncryptionService', () => {
  const goodKey = crypto.randomBytes(32).toString('base64');
  let originalKey: string | undefined;

  beforeEach(() => {
    originalKey = process.env.TELEGRAM_ENCRYPTION_KEY;
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.TELEGRAM_ENCRYPTION_KEY;
    else process.env.TELEGRAM_ENCRYPTION_KEY = originalKey;
  });

  it('round-trips ciphertext when the key is configured correctly', () => {
    process.env.TELEGRAM_ENCRYPTION_KEY = goodKey;
    const svc = new EncryptionService();
    expect(svc.isReady()).toBe(true);
    const plain = '1234567890:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const ct = svc.encrypt(plain);
    expect(ct).not.toContain(plain);
    expect(svc.decrypt(ct)).toBe(plain);
  });

  it('produces different ciphertext each call (random IV)', () => {
    process.env.TELEGRAM_ENCRYPTION_KEY = goodKey;
    const svc = new EncryptionService();
    const plain = 'session-blob';
    expect(svc.encrypt(plain)).not.toBe(svc.encrypt(plain));
  });

  it('refuses to operate when no key is set', () => {
    delete process.env.TELEGRAM_ENCRYPTION_KEY;
    const svc = new EncryptionService();
    expect(svc.isReady()).toBe(false);
    expect(() => svc.encrypt('x')).toThrow('encryption_key_missing');
  });

  it('rejects keys that do not decode to 32 bytes', () => {
    process.env.TELEGRAM_ENCRYPTION_KEY = Buffer.from('short').toString('base64');
    const svc = new EncryptionService();
    expect(svc.isReady()).toBe(false);
  });
});