import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export class EncryptionUnavailableError extends Error {
  constructor() {
    super('TELEGRAM_ENCRYPTION_KEY is not configured; refusing to handle credentials');
    this.name = 'EncryptionUnavailableError';
  }
}

@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);
  private key: Buffer | null;

  constructor() {
    this.key = this.loadKey();
    if (!this.key) {
      this.logger.warn('TELEGRAM_ENCRYPTION_KEY is not set — encryption disabled, account writes will be rejected');
    }
  }

  isReady(): boolean {
    return this.key !== null;
  }

  encrypt(plaintext: string): string {
    if (!this.key) throw new EncryptionUnavailableError();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGO, this.key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
  }

  decrypt(payload: string): string {
    if (!this.key) throw new EncryptionUnavailableError();
    const parts = payload.split(':');
    if (parts.length !== 4 || parts[0] !== 'v1') {
      throw new Error('encryption_payload_invalid');
    }
    const [, ivB64, tagB64, encB64] = parts;
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const enc = Buffer.from(encB64, 'base64');
    if (iv.length !== IV_LENGTH || tag.length !== AUTH_TAG_LENGTH) {
      throw new Error('encryption_payload_invalid');
    }
    const decipher = crypto.createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    return dec.toString('utf8');
  }

  private loadKey(): Buffer | null {
    const raw = process.env.TELEGRAM_ENCRYPTION_KEY;
    if (!raw) return null;
    // accept base64-encoded 32-byte key or 64-char hex
    try {
      const b64 = Buffer.from(raw, 'base64');
      if (b64.length === 32) return b64;
    } catch {}
    try {
      const hex = Buffer.from(raw, 'hex');
      if (hex.length === 32) return hex;
    } catch {}
    if (raw.length === 32) return Buffer.from(raw, 'utf8');
    this.logger.error('TELEGRAM_ENCRYPTION_KEY must decode to 32 bytes (base64 or hex)');
    return null;
  }
}
