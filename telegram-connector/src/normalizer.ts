import {
  NormalizedInboundMessage,
  NormalizedMessageType,
  NormalizedParticipant,
  TelegramBotMessage,
  TelegramBotUpdate,
  TelegramChatType,
} from './types';

export function participantKey(parts: {
  tenantId: string;
  accountId: string;
  telegramChatId: string;
}): string {
  return `telegram:${parts.tenantId}:${parts.accountId}:${parts.telegramChatId}`;
}

export function detectMessageType(msg: TelegramBotMessage): NormalizedMessageType {
  if (msg.text) return 'text';
  if (msg.photo && msg.photo.length > 0) return 'image';
  if (msg.voice) return 'voice';
  if (msg.video) return 'video';
  if (msg.audio) return 'voice';
  if (msg.document) return 'file';
  if (msg.sticker) return 'unknown';
  return 'unknown';
}

export function buildParticipant(
  tenantId: string,
  accountId: string,
  msg: TelegramBotMessage,
): NormalizedParticipant {
  const chat = msg.chat;
  const from = msg.from;
  const chatType: TelegramChatType = chat.type;
  const displayName =
    (from && [from.first_name, from.last_name].filter(Boolean).join(' ').trim()) ||
    chat.title ||
    chat.username ||
    chat.first_name ||
    undefined;
  return {
    provider: 'telegram',
    telegramChatId: String(chat.id),
    telegramUserId: from ? String(from.id) : undefined,
    username: from?.username || chat.username,
    firstName: from?.first_name,
    lastName: from?.last_name,
    displayName,
    chatType,
    accountId,
    tenantId,
  };
}

export interface NormalizeContext {
  tenantId: string;
  accountId: string;
}

export function normalizeInbound(
  ctx: NormalizeContext,
  update: TelegramBotUpdate,
): NormalizedInboundMessage | null {
  const msg =
    update.message ||
    update.edited_message ||
    update.channel_post ||
    update.edited_channel_post;
  if (!msg) return null;

  const messageType = detectMessageType(msg);
  const text = msg.text || msg.caption || '';
  const externalMessageId = `${msg.chat.id}:${msg.message_id}`;

  return {
    tenantId: ctx.tenantId,
    provider: 'telegram',
    accountId: ctx.accountId,
    externalMessageId,
    externalConversationId: String(msg.chat.id),
    participantKey: participantKey({
      tenantId: ctx.tenantId,
      accountId: ctx.accountId,
      telegramChatId: String(msg.chat.id),
    }),
    participant: buildParticipant(ctx.tenantId, ctx.accountId, msg),
    direction: 'inbound',
    messageType,
    text,
    timestamp: new Date(msg.date * 1000).toISOString(),
    providerPayload: { update_id: update.update_id, message: msg },
  };
}
