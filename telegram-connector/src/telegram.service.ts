import { Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { AccountStoreService } from './accounts/account-store.service';
import { DurableEventStoreService } from './inbound/durable-event-store.service';
import { OutboundService, OutboundSendInput, OutboundSendResult } from './outbound/outbound.service';
import { normalizeUpdate, TelegramUpdate } from './inbound/normalizer';

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);

  constructor(
    private readonly accounts: AccountStoreService,
    private readonly events: DurableEventStoreService,
    private readonly outbound: OutboundService,
  ) {}

  requireApiKey(headerKey: string | undefined): void {
    const expected = process.env.TELEGRAM_CONNECTOR_API_KEY;
    if (!expected) return; // dev mode
    if (headerKey !== expected) {
      throw new UnauthorizedException({ error: 'invalid_api_key' });
    }
  }

  verifyWebhookSecret(headerSecret: string | undefined): void {
    const expected = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
    if (!expected) return;
    if (headerSecret !== expected) {
      throw new UnauthorizedException({ error: 'invalid_telegram_secret_token' });
    }
  }

  /**
   * Persist a Telegram update into the durable event store. The drainer
   * (running on an interval) will pick it up and forward to Sigcore via
   * the generic provider-ingest endpoint.
   */
  async receiveWebhook(
    tenantId: string,
    accountId: string,
    update: TelegramUpdate,
  ): Promise<{ accepted: boolean }> {
    const acct = await this.accounts.getForTenant(tenantId, accountId);
    const normalized = normalizeUpdate(update, { tenantId: acct.tenantId, accountId: acct.id });
    if (!normalized) {
      this.logger.debug('Webhook with no message — ignoring');
      return { accepted: false };
    }

    await this.events.enqueue({
      tenantId: acct.tenantId,
      accountId: acct.id,
      externalMessageId: normalized.externalMessageId,
      externalConversationId: normalized.externalConversationId,
      participantKey: normalized.participantKey,
      payload: update as unknown as Record<string, unknown>,
      normalizedPayload: normalized as unknown as Record<string, unknown>,
    });

    return { accepted: true };
  }

  async send(input: OutboundSendInput): Promise<OutboundSendResult> {
    return this.outbound.send(input);
  }

  async getAccountStatus(tenantId: string, accountId: string) {
    const acct = await this.accounts.getForTenant(tenantId, accountId);
    return {
      id: acct.id,
      tenantId: acct.tenantId,
      mode: acct.mode,
      status: acct.status,
      displayName: acct.displayName,
      botUsername: acct.botUsername,
      lastConnectedAt: acct.lastConnectedAt,
      lastPingAt: acct.lastPingAt,
      reconnectAttempts: acct.reconnectAttempts,
    };
  }
}
