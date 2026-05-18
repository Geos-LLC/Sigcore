export interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  from?: { id: number; username?: string; first_name?: string; last_name?: string };
  chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; title?: string; username?: string; first_name?: string; last_name?: string };
  photo?: unknown;
  video?: unknown;
  voice?: unknown;
  document?: unknown;
  sticker?: unknown;
  audio?: unknown;
}

export interface NormalizedInbound {
  tenantId: string;
  accountId: string;
  externalMessageId: string;
  externalConversationId: string;
  participantKey: string;
  direction: 'inbound';
  messageType: 'text' | 'image' | 'file' | 'voice' | 'video' | 'sticker' | 'unknown';
  text: string;
  timestamp: string;
  providerMetadata: {
    provider: 'telegram';
    tenantId: string;
    accountId: string;
    telegramChatId: string;
    telegramUserId?: string;
    username?: string;
    firstName?: string;
    lastName?: string;
    displayName?: string;
    phone?: string;
    chatType?: 'private' | 'group' | 'supergroup' | 'channel';
  };
  providerPayload: unknown;
}

function pickMessage(update: TelegramUpdate): TelegramMessage | null {
  return (
    update.message ||
    update.edited_message ||
    update.channel_post ||
    update.edited_channel_post ||
    null
  );
}

function classify(msg: TelegramMessage): NormalizedInbound['messageType'] {
  if (msg.text) return 'text';
  if (msg.photo) return 'image';
  if (msg.voice) return 'voice';
  if (msg.video) return 'video';
  if (msg.sticker) return 'sticker';
  if (msg.document || msg.audio) return 'file';
  return 'unknown';
}

export function normalizeUpdate(
  update: TelegramUpdate,
  ctx: { tenantId: string; accountId: string },
): NormalizedInbound | null {
  const msg = pickMessage(update);
  if (!msg) return null;

  const chatId = String(msg.chat.id);
  const userId = msg.from?.id != null ? String(msg.from.id) : undefined;
  const username = msg.from?.username || msg.chat.username;
  const firstName = msg.from?.first_name || msg.chat.first_name;
  const lastName = msg.from?.last_name || msg.chat.last_name;
  const displayName =
    [firstName, lastName].filter(Boolean).join(' ') || msg.chat.title || username || 'Telegram user';

  return {
    tenantId: ctx.tenantId,
    accountId: ctx.accountId,
    externalMessageId: `${chatId}:${msg.message_id}`,
    externalConversationId: chatId,
    participantKey: `telegram:${ctx.tenantId}:${ctx.accountId}:${chatId}`,
    direction: 'inbound',
    messageType: classify(msg),
    text: msg.text || msg.caption || '',
    timestamp: new Date((msg.date || Date.now() / 1000) * 1000).toISOString(),
    providerMetadata: {
      provider: 'telegram',
      tenantId: ctx.tenantId,
      accountId: ctx.accountId,
      telegramChatId: chatId,
      telegramUserId: userId,
      username,
      firstName,
      lastName,
      displayName,
      chatType: msg.chat.type,
    },
    providerPayload: update,
  };
}
