import { Injectable, Logger } from '@nestjs/common';
import {
  AccountStatusResult,
  SendMessageInput,
  SendMessageResult,
  TelegramTransport,
} from './telegram-transport';

export function mtprotoEnabled(): boolean {
  return process.env.TELEGRAM_MTPROTO_ENABLED === 'true';
}

/**
 * MTProto / GramJS transport — INTENTIONALLY STUBBED for MVP.
 *
 * Telegram user-session ownership lives in TelePorter today.  Until that
 * decision changes, this transport refuses to send so it cannot accidentally
 * be used in production.  The interface, account fields, and factory plumbing
 * exist so Phase 4 can swap in a real implementation behind the same flag
 * (TELEGRAM_MTPROTO_ENABLED=true) without touching call-sites.
 *
 * When implemented, the contract is:
 *   - reconstruct GramJS client from `account.gramjsSessionEncrypted`
 *     (decrypted through `AccountStoreService.getGramjsSession`)
 *   - send / receive on a per-account TCP connection with health pings
 *     driving `lastPingAt` / `status` transitions
 *   - never round-trip a phone code / 2FA password through this service —
 *     sessions arrive already-baked from the operator tooling
 */
@Injectable()
export class MTProtoTransport implements TelegramTransport {
  readonly kind = 'mtproto' as const;
  private readonly logger = new Logger(MTProtoTransport.name);

  async sendMessage(_input: SendMessageInput): Promise<SendMessageResult> {
    if (!mtprotoEnabled()) {
      return { ok: false, status: 'failed', error: 'mtproto_disabled' };
    }
    this.logger.warn('MTProto transport invoked, but the driver is not implemented yet');
    return { ok: false, status: 'failed', error: 'mtproto_outbound_not_implemented' };
  }

  async getAccountStatus(_account: SendMessageInput['account']): Promise<AccountStatusResult> {
    if (!mtprotoEnabled()) return { status: 'disconnected', error: 'mtproto_disabled' };
    return { status: 'disconnected', error: 'mtproto_status_not_implemented' };
  }
}
