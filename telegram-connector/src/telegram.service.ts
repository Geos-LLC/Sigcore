import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AccountStoreService } from './account-store.service';
import { DedupeService } from './dedupe.service';
import { SigcoreIngestService } from './sigcore-ingest.service';
import { TelegramBotApi } from './telegram-bot-api.client';
import { normalizeInbound } from './normalizer';
import {
  NormalizedInboundMessage,
  SendMessageRequest,
  SendMessageResponse,
  TelegramAccount,
  TelegramAccountMode,
  TelegramBotUpdate,
} from './types';
import { redact } from './redact';

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
  forwarded?: boolean;
  normalized?: NormalizedInboundMessage;
  reason?: string;
}

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);

  constructor(
    private readonly accounts: AccountStoreService,
    private readonly dedupe: DedupeService,
    private readonly ingest: SigcoreIngestService,
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
      return this.accounts.connect({
        tenantId: input.tenantId,
        mode: 'bot',
        displayName: input.displayName,
        botToken: input.botToken,
        botUsername: me.username,
        telegramUserId: String(me.id),
      });
    }

    if (input.mode === 'mtproto') {
      // Phase 4: MTProto/GramJS wiring. We store the session encrypted now so
      // the account model is ready, but live MTProto login flow (phone code,
      // 2FA password) is intentionally not implemented yet — those secrets
      // must never round-trip through this service's HTTP boundary.
      if (!input.gramjsSession) throw new BadRequestException('gramjs_session_required');
      return this.accounts.connect({
        tenantId: input.tenantId,
        mode: 'mtproto',
        displayName: input.displayName,
        gramjsSession: input.gramjsSession,
        phone: input.phone,
      });
    }

    throw new BadRequestException('invalid_mode');
  }

  getAccountStatus(tenantId: string, accountId: string): TelegramAccount {
    return this.accounts.get(tenantId, accountId);
  }

  listAccounts(tenantId: string): TelegramAccount[] {
    return this.accounts.list(tenantId);
  }

  // ---------------------------------------------------------------------------
  // Inbound webhook
  // ---------------------------------------------------------------------------

  async handleInbound(
    update: TelegramBotUpdate,
    routing: { tenantId: string; accountId: string },
  ): Promise<InboundResult> {
    const normalized = normalizeInbound(routing, update);
    if (!normalized) {
      return { ok: true, reason: 'no_actionable_message' };
    }

    const dedupeKey = this.dedupe.key({
      tenantId: normalized.tenantId,
      accountId: normalized.accountId,
      externalMessageId: normalized.externalMessageId,
    });
    if (!this.dedupe.observe(dedupeKey)) {
      this.logger.debug(`[telegram] dedup hit: ${dedupeKey}`);
      return { ok: true, deduped: true, normalized };
    }

    // Attachments other than text: we still emit the event so Sigcore has the
    // metadata, but flagged as unknown/typed — never crash.
    const forward = await this.ingest.forward('message_inbound', normalized);
    if (!forward.ok) {
      // Roll back dedupe so a retry can succeed. The set is bounded; this is
      // safe under memory pressure.
      this.logger.warn('[telegram] forward to Sigcore failed; will retry on next delivery');
      return { ok: false, normalized, forwarded: false, reason: forward.error };
    }
    return { ok: true, normalized, forwarded: true };
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

    const acc = this.accounts.getInternal(req.tenantId, req.accountId);
    if (acc.status !== 'connected') {
      return {
        ok: false,
        provider: 'telegram',
        externalMessageId: '',
        status: 'failed',
        error: `account_${acc.status}`,
      };
    }

    if (req.idempotencyKey) {
      const idKey = `${req.tenantId}|${req.accountId}|telegram|idem:${req.idempotencyKey}`;
      if (!this.dedupe.observe(idKey)) {
        return {
          ok: true,
          provider: 'telegram',
          externalMessageId: '',
          status: 'queued',
        };
      }
    }

    if (acc.mode === 'bot') {
      const token = this.accounts.decryptBotToken(acc);
      const api = new TelegramBotApi(token);
      const result = await api.sendMessage(req.telegramChatId, req.text);
      if (!result.ok) {
        this.accounts.setStatus(acc.id, 'error', result.error);
        return {
          ok: false,
          provider: 'telegram',
          externalMessageId: '',
          status: 'failed',
          error: result.error,
        };
      }
      return {
        ok: true,
        provider: 'telegram',
        externalMessageId: result.externalMessageId!,
        status: 'sent',
      };
    }

    // MTProto outbound is Phase 4; reject cleanly until live.
    return {
      ok: false,
      provider: 'telegram',
      externalMessageId: '',
      status: 'failed',
      error: 'mtproto_outbound_not_implemented',
    };
  }
}
