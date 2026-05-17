import {
  BadRequestException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AccountStoreService } from './account-store.service';
import { DedupeService } from './dedupe.service';
import { InboundEventsStore } from './inbound-events.store';
import { EventBusService } from './event-bus.service';
import { TelegramBotApi } from './telegram-bot-api.client';
import { TransportFactory } from './transports/transport.factory';
import { normalizeInbound } from './normalizer';
import {
  InboundEventRecord,
  NormalizedInboundMessage,
  SendMessageRequest,
  SendMessageResponse,
  TelegramAccount,
  TelegramAccountMode,
  TelegramBotUpdate,
} from './types';

export interface ConnectAccountInput {
  tenantId: string;
  mode: TelegramAccountMode;
  displayName: string;
  botToken?: string;
  gramjsSession?: string;
  phone?: string;
}

export interface InboundResult {
  ok: boolean;
  deduped?: boolean;
  enqueued?: boolean;
  eventId?: string;
  normalized?: NormalizedInboundMessage;
  reason?: string;
}

/**
 * High-level orchestration for the connector. Owns account lifecycle and the
 * inbound/outbound boundaries — the durable store, drainer, and Sigcore
 * ingest live next door and are wired in via DI.
 */
@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);

  constructor(
    private readonly accounts: AccountStoreService,
    private readonly dedupe: DedupeService,
    private readonly inboundStore: InboundEventsStore,
    private readonly eventBus: EventBusService,
    private readonly transports: TransportFactory,
  ) {}

  // ---------------------------------------------------------------------------
  // Account management
  // ---------------------------------------------------------------------------

  async connectAccount(input: ConnectAccountInput): Promise<TelegramAccount> {
    if (input.mode === 'bot') {
      if (!input.botToken) throw new BadRequestException('bot_token_required');
      const api = new TelegramBotApi(input.botToken);
      const me = await api.getMe();
      if (!me) {
        throw new UnprocessableEntityException('bot_token_invalid');
      }
      const acc = this.accounts.connect({
        tenantId: input.tenantId,
        mode: 'bot',
        displayName: input.displayName,
        botToken: input.botToken,
        botUsername: me.username,
        telegramUserId: String(me.id),
      });
      this.emitConnected(acc);
      return acc;
    }

    if (input.mode === 'mtproto') {
      // Phase 4: encrypted GramJS session storage is wired; live MTProto login
      // (phone code, 2FA password) is intentionally not implemented yet.
      if (!input.gramjsSession) throw new BadRequestException('gramjs_session_required');
      const acc = this.accounts.connect({
        tenantId: input.tenantId,
        mode: 'mtproto',
        displayName: input.displayName,
        gramjsSession: input.gramjsSession,
        phone: input.phone,
      });
      this.emitConnected(acc);
      return acc;
    }

    throw new BadRequestException('invalid_mode');
  }

  private emitConnected(acc: TelegramAccount) {
    this.eventBus.emit('provider.account.connected', {
      tenantId: acc.tenantId,
      accountId: acc.id,
      data: {
        mode: acc.mode,
        displayName: acc.displayName,
        botUsername: acc.botUsername,
        telegramUserId: acc.telegramUserId,
      },
    }).catch(() => {/* logged inside */});
  }

  getAccountStatus(tenantId: string, accountId: string): TelegramAccount {
    return this.accounts.get(tenantId, accountId);
  }

  listAccounts(tenantId: string): TelegramAccount[] {
    return this.accounts.list(tenantId);
  }

  async disconnectAccount(tenantId: string, accountId: string): Promise<void> {
    // Tenant scope check
    this.accounts.get(tenantId, accountId);
    this.accounts.setStatus(accountId, 'disconnected');
    this.eventBus.emit('provider.account.disconnected', {
      tenantId, accountId, data: { reason: 'operator_request' },
    }).catch(() => {/* logged inside */});
  }

  // ---------------------------------------------------------------------------
  // Inbound webhook
  //
  // Boundary contract: enqueue durably and return. The drainer is the only
  // thing that talks to Sigcore for messages. Failures to enqueue are a hard
  // error (the request should retry); ingest-side failures are absorbed by
  // the drainer + dead-letter behavior.
  // ---------------------------------------------------------------------------

  handleInbound(
    update: TelegramBotUpdate,
    routing: { tenantId: string; accountId: string },
  ): InboundResult {
    const normalized = normalizeInbound(routing, update);
    if (!normalized) {
      return { ok: true, reason: 'no_actionable_message' };
    }
    const { enqueued, record } = this.inboundStore.enqueue(normalized, {
      update_id: update.update_id,
    });
    if (!enqueued) {
      this.logger.debug(`[telegram] dedup hit (durable): event=${record.id}`);
      return { ok: true, deduped: true, eventId: record.id, normalized };
    }
    return { ok: true, enqueued: true, eventId: record.id, normalized };
  }

  // Exposed for tests / future operator tooling
  getEvent(eventId: string): InboundEventRecord | undefined {
    return this.inboundStore.get(eventId);
  }

  // ---------------------------------------------------------------------------
  // Outbound
  // ---------------------------------------------------------------------------

  async sendMessage(req: SendMessageRequest): Promise<SendMessageResponse> {
    if (!req.tenantId || !req.accountId) {
      throw new BadRequestException('tenant_and_account_required');
    }
    if (!req.telegramChatId || !req.text) {
      throw new BadRequestException('chat_id_and_text_required');
    }

    // Throws NotFoundException on cross-tenant access
    const acc = this.accounts.getInternal(req.tenantId, req.accountId);
    if (acc.status !== 'connected') {
      const failResp: SendMessageResponse = {
        ok: false,
        provider: 'telegram',
        externalMessageId: '',
        status: 'failed',
        error: `account_${acc.status}`,
      };
      this.emitMessageFailed(req, failResp.error!);
      return failResp;
    }

    if (req.idempotencyKey) {
      const idKey = this.dedupe.idempotencyKey({
        tenantId: req.tenantId, accountId: req.accountId, key: req.idempotencyKey,
      });
      if (!this.dedupe.observe(idKey)) {
        // Duplicate send within the idempotency window — treat as queued
        // without re-sending. Status is `queued` per the spec.
        return {
          ok: true,
          provider: 'telegram',
          externalMessageId: '',
          status: 'queued',
        };
      }
    }

    if (acc.mode === 'mtproto' && !this.transports.isMtprotoEnabled()) {
      // Phase 4 not enabled: clean rejection rather than attempting a send.
      const out: SendMessageResponse = {
        ok: false,
        provider: 'telegram',
        externalMessageId: '',
        status: 'failed',
        error: 'mtproto_outbound_not_implemented',
      };
      this.emitMessageFailed(req, out.error!);
      return out;
    }

    let decrypted: string;
    try {
      decrypted = acc.mode === 'bot'
        ? this.accounts.decryptBotToken(acc)
        : this.accounts.decryptGramjsSession(acc);
    } catch (err) {
      const error = err instanceof Error ? err.message : 'decrypt_failed';
      this.emitMessageFailed(req, error);
      return { ok: false, provider: 'telegram', externalMessageId: '', status: 'failed', error };
    }

    const transport = this.transports.forMode(acc.mode);
    const result = await transport.sendMessage({
      account: acc,
      decryptedSecret: decrypted,
      telegramChatId: req.telegramChatId,
      text: req.text,
    });

    if (!result.ok) {
      this.accounts.setStatus(acc.id, 'error', result.error);
      this.emitMessageFailed(req, result.error || 'send_failed');
      return {
        ok: false,
        provider: 'telegram',
        externalMessageId: '',
        status: 'failed',
        error: result.error,
      };
    }

    this.eventBus.emit('message.sent', {
      tenantId: req.tenantId,
      accountId: req.accountId,
      data: {
        externalMessageId: result.externalMessageId,
        telegramChatId: req.telegramChatId,
        conversationId: req.conversationId,
      },
    }).catch(() => {/* logged inside */});

    return {
      ok: true,
      provider: 'telegram',
      externalMessageId: result.externalMessageId!,
      status: 'sent',
    };
  }

  private emitMessageFailed(req: SendMessageRequest, error: string) {
    this.eventBus.emit('message.failed', {
      tenantId: req.tenantId,
      accountId: req.accountId,
      data: {
        telegramChatId: req.telegramChatId,
        conversationId: req.conversationId,
        error,
        terminal: false,
      },
    }).catch(() => {/* logged inside */});
  }
}
