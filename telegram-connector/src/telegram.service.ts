import { Injectable, Logger } from '@nestjs/common';
import { AccountStoreService, ConnectInput } from './accounts/account-store.service';
import { TelegramAccountPublic, toPublic } from './accounts/account.types';
import { DurableEventStoreService } from './inbound/durable-event-store.service';
import {
  TelegramUpdate,
  fallbackDedupeKey,
  normalize,
} from './inbound/normalizer';
import { TransportFactory } from './transport/transport.factory';
import { SigcoreIngestService } from './events/sigcore-ingest.service';
import { OutboundService, SendInput, SendOutput } from './outbound/outbound.service';
import { mtprotoEnabled } from './transport/mtproto.transport';
import { safeStringify } from './common/redact';

export interface IngestResult {
  status: 'enqueued' | 'duplicate' | 'ignored';
  reason?: string;
}

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);

  constructor(
    private readonly accounts: AccountStoreService,
    private readonly events: DurableEventStoreService,
    private readonly transports: TransportFactory,
    private readonly ingest: SigcoreIngestService,
    private readonly outbound: OutboundService,
  ) {}

  // ===== Account lifecycle ============================================
  async connectAccount(input: ConnectInput): Promise<TelegramAccountPublic> {
    if (input.mode === 'mtproto' && !mtprotoEnabled()) {
      throw new Error('mtproto_disabled');
    }
    const record = await this.accounts.connect(input);

    // Validate against the Telegram API where we can (bot only).
    const transport = this.transports.forAccount(record);
    if (transport) {
      const status = await transport.getAccountStatus(record);
      await this.accounts.updateStatus(record.id, status.status, {
        lastError: status.error,
        lastConnectedAt: status.status === 'connected' ? new Date().toISOString() : undefined,
        lastPingAt: new Date().toISOString(),
        reconnectAttempts: 0,
        telegramUserId: status.telegramUserId,
        botUsername: status.botUsername,
      });
      const fresh = (await this.accounts.get(record.tenantId, record.id))!;
      this.ingest.emitProviderEvent({
        eventType: status.status === 'connected' ? 'provider.account.connected' : 'provider.account.disconnected',
        tenantId: fresh.tenantId,
        accountId: fresh.id,
        occurredAt: new Date().toISOString(),
        data: { mode: fresh.mode, botUsername: fresh.botUsername, telegramUserId: fresh.telegramUserId },
      }).catch(() => {});
      return toPublic(fresh);
    }
    return toPublic(record);
  }

  async getAccountStatus(tenantId: string, accountId: string): Promise<TelegramAccountPublic | null> {
    const record = await this.accounts.get(tenantId, accountId);
    return record ? toPublic(record) : null;
  }

  async listAccounts(tenantId: string): Promise<TelegramAccountPublic[]> {
    const records = await this.accounts.list(tenantId);
    return records.map(toPublic);
  }

  async disconnectAccount(tenantId: string, accountId: string): Promise<boolean> {
    const ok = await this.accounts.disconnect(tenantId, accountId);
    if (ok) {
      this.ingest.emitProviderEvent({
        eventType: 'provider.account.disconnected',
        tenantId,
        accountId,
        occurredAt: new Date().toISOString(),
        data: { reason: 'manual_disconnect' },
      }).catch(() => {});
    }
    return ok;
  }

  // ===== Inbound webhook intake ======================================
  async ingestUpdate(tenantId: string, accountId: string, update: TelegramUpdate): Promise<IngestResult> {
    const account = await this.accounts.get(tenantId, accountId);
    if (!account) {
      this.logger.warn(`update for unknown tenant/account ${tenantId}/${accountId}`);
      return { status: 'ignored', reason: 'telegram_account_not_found' };
    }
    if (account.mode !== 'bot') {
      // MVP: only bot mode receives via webhook.  MTProto webhook intake stays off.
      return { status: 'ignored', reason: 'non_bot_account' };
    }

    const { message } = normalize(update, { tenantId, accountId });
    if (!message) return { status: 'ignored', reason: 'no_message_in_update' };

    const msg = update.message || update.channel_post || update.edited_message;
    const fallback = msg ? fallbackDedupeKey(msg) : `${tenantId}:${accountId}:${update.update_id}`;

    const enqueued = await this.events.enqueueIfNew(message, fallback, update as unknown as Record<string, unknown>);
    if (!enqueued) {
      this.logger.debug(`duplicate update ignored ${safeStringify({ tenantId, accountId, externalMessageId: message.externalMessageId })}`);
      return { status: 'duplicate' };
    }
    return { status: 'enqueued' };
  }

  // ===== Outbound =====================================================
  async send(input: SendInput): Promise<SendOutput> {
    return this.outbound.send(input);
  }

  async listDeadEvents(tenantId: string) {
    const all = await this.events.listByStatus('dead');
    return all.filter((e) => e.tenantId === tenantId);
  }
}
