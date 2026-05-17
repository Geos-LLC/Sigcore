import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { EncryptionService } from './encryption.service';
import {
  StoredTelegramAccount,
  TelegramAccount,
  TelegramAccountMode,
  TelegramAccountStatus,
} from './types';

interface ConnectInput {
  tenantId: string;
  mode: TelegramAccountMode;
  displayName: string;
  botToken?: string;
  gramjsSession?: string;
  botUsername?: string;
  phone?: string;
  telegramUserId?: string;
}

@Injectable()
export class AccountStoreService {
  private readonly logger = new Logger(AccountStoreService.name);
  private readonly accounts = new Map<string, StoredTelegramAccount>();
  private readonly persistencePath: string;

  constructor(private readonly encryption: EncryptionService) {
    this.persistencePath = path.join(process.cwd(), 'data', 'telegram-accounts', 'accounts.json');
    this.load();
  }

  private load() {
    try {
      if (!fs.existsSync(this.persistencePath)) return;
      const raw = fs.readFileSync(this.persistencePath, 'utf8');
      const parsed = JSON.parse(raw) as StoredTelegramAccount[];
      for (const acc of parsed) this.accounts.set(acc.id, acc);
      this.logger.log(`Loaded ${this.accounts.size} Telegram accounts from disk`);
    } catch (err) {
      this.logger.warn(`Failed to load accounts: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  private persist() {
    try {
      fs.mkdirSync(path.dirname(this.persistencePath), { recursive: true });
      fs.writeFileSync(
        this.persistencePath,
        JSON.stringify(Array.from(this.accounts.values()), null, 2),
        { mode: 0o600 },
      );
    } catch (err) {
      this.logger.warn(`Failed to persist accounts: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  list(tenantId: string): TelegramAccount[] {
    return Array.from(this.accounts.values())
      .filter(a => a.tenantId === tenantId)
      .map(stripSecrets);
  }

  get(tenantId: string, accountId: string): TelegramAccount {
    const acc = this.accounts.get(accountId);
    if (!acc || acc.tenantId !== tenantId) {
      throw new NotFoundException('telegram_account_not_found');
    }
    return stripSecrets(acc);
  }

  /**
   * Internal accessor: returns the full record with credential ciphertexts so
   * the service layer can decrypt for outbound sends. Never expose this to HTTP
   * handlers — tenant isolation lives at the boundary.
   */
  getInternal(tenantId: string, accountId: string): StoredTelegramAccount {
    const acc = this.accounts.get(accountId);
    if (!acc || acc.tenantId !== tenantId) {
      throw new NotFoundException('telegram_account_not_found');
    }
    return acc;
  }

  findByBotUsername(botUsername: string): StoredTelegramAccount | null {
    for (const acc of this.accounts.values()) {
      if (acc.mode === 'bot' && acc.botUsername === botUsername) return acc;
    }
    return null;
  }

  connect(input: ConnectInput): TelegramAccount {
    if (!this.encryption.isReady()) {
      throw new Error('encryption_key_missing');
    }
    if (input.mode === 'bot' && !input.botToken) {
      throw new Error('bot_token_required');
    }
    if (input.mode === 'mtproto' && !input.gramjsSession) {
      throw new Error('gramjs_session_required');
    }

    const now = new Date().toISOString();
    const id = `acct_${cryptoRandom()}`;
    const acc: StoredTelegramAccount = {
      id,
      tenantId: input.tenantId,
      provider: 'telegram',
      mode: input.mode,
      displayName: input.displayName,
      botUsername: input.botUsername,
      phone: input.phone,
      telegramUserId: input.telegramUserId,
      status: 'connected',
      createdAt: now,
      updatedAt: now,
      botTokenEncrypted: input.botToken
        ? this.encryption.encrypt(input.botToken)
        : undefined,
      gramjsSessionEncrypted: input.gramjsSession
        ? this.encryption.encrypt(input.gramjsSession)
        : undefined,
    };
    this.accounts.set(id, acc);
    this.persist();
    return stripSecrets(acc);
  }

  setStatus(accountId: string, status: TelegramAccountStatus, lastError?: string) {
    const acc = this.accounts.get(accountId);
    if (!acc) return;
    acc.status = status;
    acc.lastError = lastError;
    acc.updatedAt = new Date().toISOString();
    this.persist();
  }

  decryptBotToken(acc: StoredTelegramAccount): string {
    if (!acc.botTokenEncrypted) throw new Error('no_bot_token');
    return this.encryption.decrypt(acc.botTokenEncrypted);
  }
}

function stripSecrets(acc: StoredTelegramAccount): TelegramAccount {
  const { botTokenEncrypted, gramjsSessionEncrypted, ...rest } = acc;
  return rest;
}

function cryptoRandom(): string {
  // 16 hex chars = 8 random bytes; collision-resistant for this use case.
  return require('crypto').randomBytes(8).toString('hex');
}