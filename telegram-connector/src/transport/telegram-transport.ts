import { TelegramAccountRecord, TelegramAccountStatus } from '../accounts/account.types';

export interface SendMessageInput {
  account: TelegramAccountRecord;
  telegramChatId: string;
  text: string;
}

export interface SendMessageResult {
  ok: boolean;
  externalMessageId?: string;
  status: 'sent' | 'queued' | 'failed';
  error?: string;
}

export interface AccountStatusResult {
  status: TelegramAccountStatus;
  telegramUserId?: string;
  botUsername?: string;
  error?: string;
}

export interface TelegramTransport {
  readonly kind: 'bot' | 'mtproto';
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;
  getAccountStatus(account: TelegramAccountRecord): Promise<AccountStatusResult>;
}
