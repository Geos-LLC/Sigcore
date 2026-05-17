import { Logger } from '@nestjs/common';
import {
  StoredTelegramAccount,
  TelegramTransport,
  TelegramTransportSendInput,
  TelegramTransportSendResult,
  TelegramTransportStatus,
} from '../types';
import { TelegramBotApi } from '../telegram-bot-api.client';

/**
 * Telegram Bot API transport. Driven by an encrypted bot token decrypted by
 * the caller — this class never sees the ciphertext or the encryption key.
 */
export class BotTransport implements TelegramTransport {
  readonly mode = 'bot' as const;
  private readonly logger = new Logger(BotTransport.name);

  async sendMessage(input: TelegramTransportSendInput): Promise<TelegramTransportSendResult> {
    const api = new TelegramBotApi(input.decryptedSecret);
    const result = await api.sendMessage(input.telegramChatId, input.text);
    return result;
  }

  async getAccountStatus(input: {
    account: StoredTelegramAccount;
    decryptedSecret?: string;
  }): Promise<TelegramTransportStatus> {
    const now = new Date().toISOString();
    if (!input.decryptedSecret) {
      return { ok: false, status: 'error', error: 'no_credentials', pingedAt: now };
    }
    const api = new TelegramBotApi(input.decryptedSecret);
    const me = await api.getMe();
    if (!me) {
      return { ok: false, status: 'expired', error: 'getMe_failed', pingedAt: now };
    }
    return { ok: true, status: 'connected', pingedAt: now };
  }
}
