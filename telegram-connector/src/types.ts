export type TelegramAccountMode = 'bot' | 'mtproto';

export type TelegramAccountStatus =
  | 'connected'
  | 'disconnected'
  | 'expired'
  | 'error';

export interface TelegramAccount {
  id: string;
  tenantId: string;
  provider: 'telegram';
  mode: TelegramAccountMode;
  displayName: string;
  botUsername?: string;
  telegramUserId?: string;
  phone?: string;
  status: TelegramAccountStatus;
  lastError?: string;
  lastConnectedAt?: string;
  lastPingAt?: string;
  reconnectAttempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoredTelegramAccount extends TelegramAccount {
  botTokenEncrypted?: string;
  gramjsSessionEncrypted?: string;
}

export type TelegramChatType = 'private' | 'group' | 'supergroup' | 'channel';

export type NormalizedMessageType =
  | 'text'
  | 'image'
  | 'file'
  | 'voice'
  | 'video'
  | 'unknown';

export interface NormalizedParticipant {
  provider: 'telegram';
  telegramChatId: string;
  telegramUserId?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  phone?: string;
  chatType?: TelegramChatType;
  accountId: string;
  tenantId: string;
}

export interface NormalizedInboundMessage {
  tenantId: string;
  provider: 'telegram';
  accountId: string;
  externalMessageId: string;
  externalConversationId: string;
  participantKey: string;
  participant: NormalizedParticipant;
  direction: 'inbound';
  messageType: NormalizedMessageType;
  text: string;
  timestamp: string;
  providerPayload: Record<string, unknown>;
}

export interface SendMessageRequest {
  tenantId: string;
  accountId: string;
  conversationId?: string;
  telegramChatId: string;
  text: string;
  idempotencyKey?: string;
}

export interface SendMessageResponse {
  ok: boolean;
  provider: 'telegram';
  externalMessageId: string;
  status: 'sent' | 'queued' | 'failed';
  error?: string;
}

export interface TelegramBotUpdate {
  update_id: number;
  message?: TelegramBotMessage;
  edited_message?: TelegramBotMessage;
  channel_post?: TelegramBotMessage;
  edited_channel_post?: TelegramBotMessage;
}

export interface TelegramBotMessage {
  message_id: number;
  date: number;
  chat: {
    id: number;
    type: TelegramChatType;
    title?: string;
    username?: string;
    first_name?: string;
    last_name?: string;
  };
  from?: {
    id: number;
    is_bot: boolean;
    first_name?: string;
    last_name?: string;
    username?: string;
    language_code?: string;
  };
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number }>;
  document?: { file_id: string; file_name?: string; mime_type?: string };
  voice?: { file_id: string; duration: number; mime_type?: string };
  video?: { file_id: string; duration: number; mime_type?: string };
  audio?: { file_id: string; duration: number; mime_type?: string };
  sticker?: { file_id: string; emoji?: string };
}

// ---------------------------------------------------------------------------
// Durable inbound event store (telegram_inbound_events)
// ---------------------------------------------------------------------------

export type InboundEventStatus =
  | 'pending'
  | 'processing'
  | 'sent'
  | 'failed'
  | 'dead';

export interface InboundEventRecord {
  id: string;
  tenantId: string;
  accountId: string;
  provider: 'telegram';
  externalMessageId: string;
  externalConversationId: string;
  participantKey: string;
  payload: Record<string, unknown>;
  normalizedPayload: NormalizedInboundMessage;
  status: InboundEventStatus;
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt?: string;
}

// ---------------------------------------------------------------------------
// Provider event bus → Sigcore (out-of-band, separate from the message
// ingestion path the drainer uses)
// ---------------------------------------------------------------------------

export type ProviderEventType =
  | 'provider.account.connected'
  | 'provider.account.disconnected'
  | 'message.received'
  | 'message.sent'
  | 'message.failed'
  | 'conversation.updated';

export interface ProviderEvent<T = Record<string, unknown>> {
  type: ProviderEventType;
  provider: 'telegram';
  tenantId: string;
  accountId?: string;
  timestamp: string;
  data: T;
}

// ---------------------------------------------------------------------------
// Transport abstraction
// ---------------------------------------------------------------------------

export interface TelegramTransportSendInput {
  account: StoredTelegramAccount;
  decryptedSecret: string; // bot token (bot mode) or gramjs session (mtproto)
  telegramChatId: string;
  text: string;
}

export interface TelegramTransportSendResult {
  ok: boolean;
  externalMessageId?: string;
  error?: string;
}

export interface TelegramTransportStatus {
  ok: boolean;
  status: TelegramAccountStatus;
  error?: string;
  pingedAt: string;
}

export interface TelegramTransport {
  readonly mode: TelegramAccountMode;
  sendMessage(input: TelegramTransportSendInput): Promise<TelegramTransportSendResult>;
  getAccountStatus(input: { account: StoredTelegramAccount; decryptedSecret?: string }): Promise<TelegramTransportStatus>;
}
