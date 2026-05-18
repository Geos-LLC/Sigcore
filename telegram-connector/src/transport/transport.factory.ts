import { Injectable } from '@nestjs/common';
import { TelegramAccountRecord } from '../accounts/account.types';
import { BotTransport } from './bot.transport';
import { MTProtoTransport, mtprotoEnabled } from './mtproto.transport';
import { TelegramTransport } from './telegram-transport';

@Injectable()
export class TransportFactory {
  constructor(
    private readonly bot: BotTransport,
    private readonly mtproto: MTProtoTransport,
  ) {}

  /** Returns the right transport, or `null` if the account's mode is disabled. */
  forAccount(account: TelegramAccountRecord): TelegramTransport | null {
    if (account.mode === 'bot') return this.bot;
    if (account.mode === 'mtproto') {
      if (!mtprotoEnabled()) return null;
      return this.mtproto;
    }
    return null;
  }
}
