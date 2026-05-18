import { Injectable, Logger } from '@nestjs/common';
import {
  SendMessageInput,
  SendMessageResult,
  TelegramTransport,
} from './telegram-transport';

/**
 * MTProto / GramJS transport. INTENTIONALLY DISABLED for MVP.
 *
 * TelePorter currently owns active Telegram MTProto user sessions client-side.
 * The connector MUST NOT migrate those sessions into Sigcore core. This class
 * exists so the transport abstraction is complete; live MTProto support will
 * land later (Phase 4 of the issue's rollout) as a driver with encrypted
 * session storage and session health monitoring.
 */
@Injectable()
export class MTProtoTransport implements TelegramTransport {
  readonly mode = 'mtproto' as const;
  private readonly logger = new Logger(MTProtoTransport.name);

  async sendMessage(_input: SendMessageInput): Promise<SendMessageResult> {
    const enabled = (process.env.TELEGRAM_MTPROTO_ENABLED || 'false').toLowerCase() === 'true';
    if (!enabled) {
      return { ok: false, status: 'failed', error: 'mtproto_disabled' };
    }
    return { ok: false, status: 'failed', error: 'mtproto_outbound_not_implemented' };
  }

  async getAccountStatus() {
    return { status: 'disconnected' as const, info: { reason: 'mtproto_disabled' } };
  }
}
