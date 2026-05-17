import { Injectable } from '@nestjs/common';
import { TelegramAccountMode, TelegramTransport } from '../types';
import { BotTransport } from './bot.transport';
import { MTProtoTransport } from './mtproto.transport';

@Injectable()
export class TransportFactory {
  private readonly bot = new BotTransport();
  private readonly mtproto = new MTProtoTransport();

  forMode(mode: TelegramAccountMode): TelegramTransport {
    if (mode === 'bot') return this.bot;
    if (mode === 'mtproto') return this.mtproto;
    throw new Error(`unknown_transport_mode:${mode}`);
  }

  isMtprotoEnabled(): boolean {
    return process.env.TELEGRAM_MTPROTO_ENABLED === 'true';
  }
}
