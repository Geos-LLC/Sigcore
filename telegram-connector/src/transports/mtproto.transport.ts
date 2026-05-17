import {
  StoredTelegramAccount,
  TelegramTransport,
  TelegramTransportSendInput,
  TelegramTransportSendResult,
  TelegramTransportStatus,
} from '../types';

/**
 * MTProto / GramJS transport stub.
 *
 * Phase 4 lives behind `TELEGRAM_MTPROTO_ENABLED`. Until the live login flow
 * (phone code, 2FA password) and GramJS outbound are wired, both calls return
 * a clean rejection so the rest of the system can be exercised end-to-end
 * with mtproto-mode accounts in the store.
 *
 * IMPORTANT: phone codes and 2FA passwords must never round-trip through
 * this service's HTTP boundary — they must be entered in a side channel and
 * the resulting session string handed to /accounts/connect already.
 */
export class MTProtoTransport implements TelegramTransport {
  readonly mode = 'mtproto' as const;

  async sendMessage(_input: TelegramTransportSendInput): Promise<TelegramTransportSendResult> {
    return { ok: false, error: 'mtproto_outbound_not_implemented' };
  }

  async getAccountStatus(_input: {
    account: StoredTelegramAccount;
    decryptedSecret?: string;
  }): Promise<TelegramTransportStatus> {
    return {
      ok: false,
      status: 'disconnected',
      error: 'mtproto_status_not_implemented',
      pingedAt: new Date().toISOString(),
    };
  }
}
