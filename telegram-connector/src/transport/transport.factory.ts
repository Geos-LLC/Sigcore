import { Injectable } from '@nestjs/common';
import { TelegramAccount } from '../accounts/telegram-account.entity';
import { BotTransport } from './bot.transport';
import { MTProtoTransport } from './mtproto.transport';
import { TelegramTransport } from './telegram-transport';

@Injectable()
export class TransportFactory {
  constructor(
    private readonly bot: BotTransport,
    private readonly mt: MTProtoTransport,
  ) {}

  forAccount(account: TelegramAccount): TelegramTransport {
    return account.mode === 'mtproto' ? this.mt : this.bot;
  }
}
