import { Injectable, Logger } from '@nestjs/common';
import { AccountStoreService } from '../accounts/account-store.service';
import {
  AccountStatusResult,
  SendMessageInput,
  SendMessageResult,
  TelegramTransport,
} from './telegram-transport';
import {
  TelegramBotApiClientFactory,
  defaultBotApiClientFactory,
} from './telegram-bot-api.client';

@Injectable()
export class BotTransport implements TelegramTransport {
  readonly kind = 'bot' as const;
  private readonly logger = new Logger(BotTransport.name);

  constructor(
    private readonly accounts: AccountStoreService,
    private readonly clientFactory: TelegramBotApiClientFactory = defaultBotApiClientFactory,
  ) {}

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    if (input.account.mode !== 'bot') {
      return { ok: false, status: 'failed', error: 'wrong_transport' };
    }
    let token: string;
    try {
      token = await this.accounts.getBotToken(input.account);
    } catch {
      return { ok: false, status: 'failed', error: 'bot_token_unavailable' };
    }
    try {
      const client = this.clientFactory(token);
      const resp = await client.sendMessage(input.telegramChatId, input.text);
      if (resp.ok && resp.result) {
        return { ok: true, status: 'sent', externalMessageId: String(resp.result.message_id) };
      }
      return { ok: false, status: 'failed', error: resp.description || 'telegram_send_failed' };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown_error';
      this.logger.warn(`bot send failed: ${msg}`);
      return { ok: false, status: 'failed', error: msg };
    }
  }

  async getAccountStatus(account: SendMessageInput['account']): Promise<AccountStatusResult> {
    if (account.mode !== 'bot') return { status: 'error', error: 'wrong_transport' };
    try {
      const token = await this.accounts.getBotToken(account);
      const client = this.clientFactory(token);
      const me = await client.getMe();
      if (me.ok && me.result) {
        return {
          status: 'connected',
          telegramUserId: String(me.result.id),
          botUsername: me.result.username,
        };
      }
      return { status: 'error', error: me.description || 'getMe_failed' };
    } catch (e) {
      return { status: 'error', error: e instanceof Error ? e.message : 'unknown_error' };
    }
  }
}
