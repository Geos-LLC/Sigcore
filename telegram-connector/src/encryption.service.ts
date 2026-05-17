import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);
  private readonly key: Buffer | null;

  constructor() {
    const raw = process.env.TELEGRAM_ENCRYPTION_KEY || '';
    if (!raw) {
      this.logger.warn(
        'TELEGRAM_ENCRYPTION_KEY is not set — refusing to store credentials. ' +
          'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
      );
      this.key = null;
      return;
    }
    const buf = Buffer.from(raw, 'base64');
    if (buf.length !== 32) {
      this.logger.warn(
        `TELEGRAM_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${buf.length}). Credentials will not be stored.`,
      );
      this.key = null;
      return;
    }
    this.key = buf;
  }

  isReady(): boolean {
    return this.key !== null;
  }

  encrypt(plaintext: string): string {
    if (!this.key) throw new Error('encryption_key_missing');
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALG, this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ct]).toString('base64');
  }

  decrypt(ciphertext: string): string {
    if (!this.key) throw new Error('encryption_key_missing');
    const buf = Buffer.from(ciphertext, 'base64');
    if (buf.length < IV_LEN + TAG_LEN) throw new Error('ciphertext_too_short');
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv(ALG, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }
}
