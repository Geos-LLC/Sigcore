import * as crypto from 'crypto';
import { EncryptionService } from './encryption.service';

describe('EncryptionService', () => {
  let svc: EncryptionService;

  beforeAll(() => {
    process.env.TELEGRAM_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    svc = new EncryptionService();
  });

  it('round-trips a bot token', () => {
    const plain = '7000000000:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const enc = svc.encrypt(plain);
    expect(enc).not.toContain(plain);
    expect(svc.decrypt(enc)).toBe(plain);
  });

  it('produces different ciphertexts for the same plaintext (random IV)', () => {
    const a = svc.encrypt('hello');
    const b = svc.encrypt('hello');
    expect(a).not.toEqual(b);
  });

  it('throws on missing key', () => {
    const prev = process.env.TELEGRAM_ENCRYPTION_KEY;
    delete process.env.TELEGRAM_ENCRYPTION_KEY;
    expect(() => new EncryptionService()).toThrow();
    process.env.TELEGRAM_ENCRYPTION_KEY = prev;
  });

  it('rejects key of wrong length', () => {
    const prev = process.env.TELEGRAM_ENCRYPTION_KEY;
    process.env.TELEGRAM_ENCRYPTION_KEY = '00';
    expect(() => new EncryptionService()).toThrow();
    process.env.TELEGRAM_ENCRYPTION_KEY = prev;
  });
});
