import { Injectable, Logger } from '@nestjs/common';
import { EncryptionService } from '../common/encryption.service';
import {
  SendMessageInput,
  SendMessageResult,
  TelegramTransport,
} from './telegram-transport';
import { getBotInfo, sendBotMessage } from './telegram-bot-api.client';

@Injectable()
export class BotTransport implements TelegramTransport {
  readonly mode = 'bot' as const;
  private readonly logger = new Logger(BotTransport.name);

  constructor(private readonly enc: EncryptionService) {}

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    if (input.account.mode !== 'bot') {
      return { ok: false, status: 'failed', error: 'account_not_bot_mode' };
    }
    if (!input.account.botTokenEncrypted) {
      return { ok: false, status: 'failed', error: 'no_bot_token' };
    }

    const token = this.enc.decrypt(input.account.botTokenEncrypted);
    const res = await sendBotMessage(token, input.telegramChatId, input.text);
    if (res.ok && res.messageId) {
      return { ok: true, status: 'sent', externalMessageId: res.messageId };
    }
    return { ok: false, status: 'failed', error: res.description || 'send_failed' };
  }

  async getAccountStatus(account: { botTokenEncrypted?: string }) {
    if (!account.botTokenEncrypted) return { status: 'disconnected' as const };
    const info = await getBotInfo(this.enc.decrypt(account.botTokenEncrypted));
    return { status: info.ok ? ('connected' as const) : ('error' as const), info };
  }
}
