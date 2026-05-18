import { Injectable, Logger } from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { EncryptionService, EncryptionUnavailableError } from '../common/encryption.service';
import {
  TelegramAccountMode,
  TelegramAccountRecord,
  TelegramAccountStatus,
} from './account.types';

export interface ConnectInput {
  tenantId: string;
  mode: TelegramAccountMode;
  displayName: string;
  botToken?: string;
  botUsername?: string;
  gramjsSession?: string;
  telegramUserId?: string;
  phone?: string;
}

/**
 * Minimal file-backed store — one JSON file per account in
 * `<dataDir>/telegram-accounts/<id>.json`.  Real deployments would swap this
 * out for Postgres + the same TelegramAccount schema; the contract here is
 * the only thing the rest of the connector depends on.
 *
 * Encryption is mandatory: refuses to create or update an account with
 * credentials unless the encryption service has a key.  This is the
 * enforcement point that makes "Telegram credentials encrypted at rest" a
 * code invariant rather than an operator-discipline thing.
 */
@Injectable()
export class AccountStoreService {
  private readonly logger = new Logger(AccountStoreService.name);
  private readonly dir: string;

  constructor(private readonly enc: EncryptionService) {
    const root = process.env.TELEGRAM_DATA_DIR || './data';
    this.dir = path.join(root, 'telegram-accounts');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  async connect(input: ConnectInput): Promise<TelegramAccountRecord> {
    if (!input.tenantId) throw new Error('tenant_id_required');
    if (!input.mode) throw new Error('mode_required');
    if (input.mode === 'bot' && !input.botToken) throw new Error('bot_token_required');
    if (input.mode === 'mtproto' && !input.gramjsSession) throw new Error('gramjs_session_required');

    if (!this.enc.isReady()) {
      throw new EncryptionUnavailableError();
    }

    const now = new Date().toISOString();
    const record: TelegramAccountRecord = {
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      provider: 'telegram',
      mode: input.mode,
      displayName: input.displayName || (input.mode === 'bot' ? input.botUsername || 'bot' : input.phone || 'mtproto'),
      botUsername: input.botUsername,
      botTokenEncrypted: input.botToken ? this.enc.encrypt(input.botToken) : undefined,
      gramjsSessionEncrypted: input.gramjsSession ? this.enc.encrypt(input.gramjsSession) : undefined,
      telegramUserId: input.telegramUserId,
      phone: input.phone,
      status: 'connected',
      reconnectAttempts: 0,
      lastConnectedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    this.write(record);
    return record;
  }

  async get(tenantId: string, accountId: string): Promise<TelegramAccountRecord | null> {
    const record = this.readRaw(accountId);
    if (!record) return null;
    if (record.tenantId !== tenantId) {
      // Cross-tenant access — treat as not-found so we never leak existence.
      return null;
    }
    return record;
  }

  /** Internal lookup that does not enforce tenant — only the receiver/drainer
   * use this after they have *already* derived tenantId from the URL/payload. */
  async getInternal(accountId: string): Promise<TelegramAccountRecord | null> {
    return this.readRaw(accountId);
  }

  async list(tenantId: string): Promise<TelegramAccountRecord[]> {
    const out: TelegramAccountRecord[] = [];
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const r = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as TelegramAccountRecord;
        if (r.tenantId === tenantId) out.push(r);
      } catch {}
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getBotToken(record: TelegramAccountRecord): Promise<string> {
    if (!record.botTokenEncrypted) throw new Error('bot_token_missing');
    return this.enc.decrypt(record.botTokenEncrypted);
  }

  async getGramjsSession(record: TelegramAccountRecord): Promise<string> {
    if (!record.gramjsSessionEncrypted) throw new Error('gramjs_session_missing');
    return this.enc.decrypt(record.gramjsSessionEncrypted);
  }

  async updateStatus(
    accountId: string,
    status: TelegramAccountStatus,
    extra: {
      lastError?: string;
      lastConnectedAt?: string;
      lastPingAt?: string;
      reconnectAttempts?: number;
      telegramUserId?: string;
      botUsername?: string;
    } = {},
  ): Promise<TelegramAccountRecord | null> {
    const record = this.readRaw(accountId);
    if (!record) return null;
    record.status = status;
    if (extra.lastError !== undefined) record.lastError = extra.lastError;
    if (extra.lastConnectedAt) record.lastConnectedAt = extra.lastConnectedAt;
    if (extra.lastPingAt) record.lastPingAt = extra.lastPingAt;
    if (extra.reconnectAttempts !== undefined) record.reconnectAttempts = extra.reconnectAttempts;
    if (extra.telegramUserId) record.telegramUserId = extra.telegramUserId;
    if (extra.botUsername) record.botUsername = extra.botUsername;
    record.updatedAt = new Date().toISOString();
    this.write(record);
    return record;
  }

  async disconnect(tenantId: string, accountId: string): Promise<boolean> {
    const record = await this.get(tenantId, accountId);
    if (!record) return false;
    fs.unlinkSync(path.join(this.dir, `${accountId}.json`));
    return true;
  }

  private readRaw(accountId: string): TelegramAccountRecord | null {
    const file = path.join(this.dir, `${accountId}.json`);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as TelegramAccountRecord;
    } catch (e) {
      this.logger.warn(`account record ${accountId} unreadable`);
      return null;
    }
  }

  private write(record: TelegramAccountRecord): void {
    fs.writeFileSync(path.join(this.dir, `${record.id}.json`), JSON.stringify(record, null, 2));
  }
}
