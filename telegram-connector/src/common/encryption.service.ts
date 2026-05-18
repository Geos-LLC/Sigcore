import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';

@Injectable()
export class EncryptionService {
  private readonly key: Buffer;

  constructor() {
    const raw = process.env.TELEGRAM_ENCRYPTION_KEY || '';
    if (!raw) {
      throw new Error(
        'TELEGRAM_ENCRYPTION_KEY is required — refuse to start without an at-rest encryption key',
      );
    }
    const buf = Buffer.from(raw, 'hex');
    if (buf.length !== 32) {
      throw new Error('TELEGRAM_ENCRYPTION_KEY must be 32 bytes (64 hex chars)');
    }
    this.key = buf;
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
  }

  decrypt(payload: string): string {
    const [ivB64, tagB64, encB64] = payload.split(':');
    if (!ivB64 || !tagB64 || !encB64) {
      throw new Error('encryption payload malformed');
    }
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const enc = Buffer.from(encB64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  }
}
