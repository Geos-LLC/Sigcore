import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { AccountStoreService } from '../accounts/account-store.service';
import { TransportFactory } from '../transport/transport.factory';
import { SigcoreIngestService } from '../events/sigcore-ingest.service';
import { SendMessageResult } from '../transport/telegram-transport';

export interface SendInput {
  tenantId: string;
  accountId: string;
  telegramChatId: string;
  text: string;
  conversationId?: string;
  idempotencyKey?: string;
}

export interface SendOutput {
  ok: boolean;
  provider: 'telegram';
  externalMessageId?: string;
  status: 'sent' | 'queued' | 'failed';
  error?: string;
  cached?: boolean;
}

/**
 * Idempotency cache: `<tenantId>:<accountId>:<idempotencyKey>` → SendOutput.
 * Lives on disk so it survives a connector restart.
 */
@Injectable()
export class OutboundService {
  private readonly logger = new Logger(OutboundService.name);
  private readonly cacheDir: string;

  constructor(
    private readonly accounts: AccountStoreService,
    private readonly transports: TransportFactory,
    private readonly ingest: SigcoreIngestService,
  ) {
    const data = process.env.TELEGRAM_DATA_DIR || './data';
    this.cacheDir = path.join(data, 'telegram-outbound-idem');
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  async send(input: SendInput): Promise<SendOutput> {
    if (!input.tenantId || !input.accountId) {
      return { ok: false, provider: 'telegram', status: 'failed', error: 'tenant_account_required' };
    }
    if (!input.telegramChatId) {
      return { ok: false, provider: 'telegram', status: 'failed', error: 'telegram_chat_id_required' };
    }
    if (!input.text) {
      return { ok: false, provider: 'telegram', status: 'failed', error: 'text_required' };
    }

    if (input.idempotencyKey) {
      const cached = this.readCache(input.tenantId, input.accountId, input.idempotencyKey);
      if (cached) return { ...cached, cached: true };
    }

    const account = await this.accounts.get(input.tenantId, input.accountId);
    if (!account) {
      return { ok: false, provider: 'telegram', status: 'failed', error: 'telegram_account_not_found' };
    }
    if (account.status === 'expired' || account.status === 'disconnected') {
      return { ok: false, provider: 'telegram', status: 'failed', error: `account_${account.status}` };
    }

    const transport = this.transports.forAccount(account);
    if (!transport) {
      return { ok: false, provider: 'telegram', status: 'failed', error: 'transport_unavailable' };
    }

    const result: SendMessageResult = await transport.sendMessage({
      account,
      telegramChatId: input.telegramChatId,
      text: input.text,
    });

    const out: SendOutput = {
      ok: result.ok,
      provider: 'telegram',
      status: result.status,
      externalMessageId: result.externalMessageId,
      error: result.error,
    };

    if (input.idempotencyKey) {
      this.writeCache(input.tenantId, input.accountId, input.idempotencyKey, out);
    }

    if (result.ok) {
      this.ingest.emitProviderEvent({
        eventType: 'message.sent',
        tenantId: input.tenantId,
        accountId: input.accountId,
        occurredAt: new Date().toISOString(),
        data: {
          externalMessageId: result.externalMessageId,
          externalConversationId: input.telegramChatId,
          conversationId: input.conversationId,
        },
      }).catch(() => {});
    } else {
      this.ingest.emitProviderEvent({
        eventType: 'message.failed',
        tenantId: input.tenantId,
        accountId: input.accountId,
        occurredAt: new Date().toISOString(),
        data: {
          externalConversationId: input.telegramChatId,
          conversationId: input.conversationId,
          error: result.error,
        },
      }).catch(() => {});
    }

    return out;
  }

  private cacheFile(tenantId: string, accountId: string, key: string): string {
    const hash = crypto.createHash('sha256').update(`${tenantId}:${accountId}:${key}`).digest('hex').slice(0, 32);
    return path.join(this.cacheDir, `${hash}.json`);
  }

  private readCache(tenantId: string, accountId: string, key: string): SendOutput | null {
    const file = this.cacheFile(tenantId, accountId, key);
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as SendOutput;
    } catch {
      return null;
    }
  }

  private writeCache(tenantId: string, accountId: string, key: string, value: SendOutput): void {
    try {
      fs.writeFileSync(this.cacheFile(tenantId, accountId, key), JSON.stringify(value));
    } catch (e) {
      this.logger.warn(`idempotency cache write failed: ${e instanceof Error ? e.message : 'unknown'}`);
    }
  }
}
