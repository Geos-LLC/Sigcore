import {
  NormalizedInboundMessage,
  NormalizedMessageType,
  ProviderMetadata,
} from './inbound.types';

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  contact?: { phone_number?: string };
  photo?: unknown[];
  document?: unknown;
  voice?: unknown;
  audio?: unknown;
  video?: unknown;
  sticker?: unknown;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export interface NormalizeContext {
  tenantId: string;
  accountId: string;
}

export interface NormalizeResult {
  /** null = update did not carry a normalizable inbound message */
  message: NormalizedInboundMessage | null;
  raw: Record<string, unknown>;
}

export function participantKey(tenantId: string, accountId: string, chatId: string | number): string {
  return `telegram:${tenantId}:${accountId}:${chatId}`;
}

function classifyMessageType(msg: TelegramMessage): NormalizedMessageType {
  if (msg.photo && msg.photo.length > 0) return 'image';
  if (msg.voice || msg.audio) return 'voice';
  if (msg.video) return 'video';
  if (msg.document || msg.sticker) return 'file';
  if (typeof msg.text === 'string' && msg.text.length > 0) return 'text';
  if (typeof msg.caption === 'string' && msg.caption.length > 0) return 'text';
  return 'unknown';
}

function buildDisplayName(user: TelegramUser | undefined, chat: TelegramChat): string | undefined {
  const userName = [user?.first_name, user?.last_name].filter(Boolean).join(' ').trim();
  if (userName) return userName;
  if (user?.username) return user.username;
  if (chat.title) return chat.title;
  const chatName = [chat.first_name, chat.last_name].filter(Boolean).join(' ').trim();
  return chatName || undefined;
}

export function normalize(update: TelegramUpdate, ctx: NormalizeContext): NormalizeResult {
  const msg = update.message || update.channel_post || update.edited_message;
  if (!msg || !msg.chat) {
    return { message: null, raw: update as unknown as Record<string, unknown> };
  }

  const chatId = String(msg.chat.id);
  const messageType = classifyMessageType(msg);
  const text = msg.text || msg.caption;

  const meta: ProviderMetadata = {
    provider: 'telegram',
    tenantId: ctx.tenantId,
    accountId: ctx.accountId,
    telegramChatId: chatId,
    telegramUserId: msg.from ? String(msg.from.id) : undefined,
    username: msg.from?.username,
    firstName: msg.from?.first_name,
    lastName: msg.from?.last_name,
    displayName: buildDisplayName(msg.from, msg.chat),
    phone: msg.contact?.phone_number,
    chatType: msg.chat.type,
  };

  const normalized: NormalizedInboundMessage = {
    tenantId: ctx.tenantId,
    provider: 'telegram',
    accountId: ctx.accountId,
    externalMessageId: String(msg.message_id),
    externalConversationId: chatId,
    participantKey: participantKey(ctx.tenantId, ctx.accountId, chatId),
    direction: 'inbound',
    messageType,
    text,
    timestamp: new Date(msg.date * 1000).toISOString(),
    providerMetadata: meta,
    providerPayload: update as unknown as Record<string, unknown>,
  };

  return { message: normalized, raw: update as unknown as Record<string, unknown> };
}

/** Fallback dedupe key when externalMessageId might not be stable. */
export function fallbackDedupeKey(msg: TelegramMessage): string {
  return `${msg.chat.id}:${msg.message_id}:${msg.date}`;
}
