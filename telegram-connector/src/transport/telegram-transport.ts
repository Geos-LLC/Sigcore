import { TelegramAccount } from '../accounts/telegram-account.entity';

export interface SendMessageInput {
  account: TelegramAccount;
  telegramChatId: string;
  text: string;
}

export interface SendMessageResult {
  ok: boolean;
  externalMessageId?: string;
  status: 'sent' | 'queued' | 'failed';
  error?: string;
}

export interface TelegramTransport {
  readonly mode: 'bot' | 'mtproto';
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;
  getAccountStatus(account: TelegramAccount): Promise<{
    status: 'connected' | 'disconnected' | 'expired' | 'error';
    info?: Record<string, unknown>;
  }>;
}
