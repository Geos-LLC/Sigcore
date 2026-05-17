import { normalizeInbound, participantKey } from './normalizer';
import { TelegramBotUpdate } from './types';

describe('participantKey', () => {
  it('produces the documented telegram:<tenant>:<account>:<chat> format', () => {
    expect(
      participantKey({ tenantId: 'tenant_123', accountId: 'acct_456', telegramChatId: 'user_789' }),
    ).toBe('telegram:tenant_123:acct_456:user_789');
  });

  it('handles negative chat ids (supergroups) without mangling them', () => {
    expect(
      participantKey({
        tenantId: 'tenant_123',
        accountId: 'acct_456',
        telegramChatId: '-1001234567890',
      }),
    ).toBe('telegram:tenant_123:acct_456:-1001234567890');
  });
});

describe('normalizeInbound', () => {
  const ctx = { tenantId: 'tenant_a', accountId: 'acct_a' };

  it('normalizes a plain text private message', () => {
    const update: TelegramBotUpdate = {
      update_id: 1,
      message: {
        message_id: 42,
        date: 1700000000,
        chat: { id: 555, type: 'private', first_name: 'Alex' },
        from: { id: 555, is_bot: false, first_name: 'Alex', username: 'alex' },
        text: 'hello',
      },
    };
    const out = normalizeInbound(ctx, update);
    expect(out).toMatchObject({
      tenantId: 'tenant_a',
      provider: 'telegram',
      accountId: 'acct_a',
      externalConversationId: '555',
      externalMessageId: '555:42',
      direction: 'inbound',
      messageType: 'text',
      text: 'hello',
      participantKey: 'telegram:tenant_a:acct_a:555',
    });
    expect(out!.participant.username).toBe('alex');
    expect(out!.timestamp).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it('classifies photos as image and uses caption as text', () => {
    const update: TelegramBotUpdate = {
      update_id: 2,
      message: {
        message_id: 7,
        date: 1700000100,
        chat: { id: 1, type: 'private' },
        photo: [{ file_id: 'f1', file_unique_id: 'u1', width: 100, height: 100 }],
        caption: 'look',
      },
    };
    const out = normalizeInbound(ctx, update);
    expect(out!.messageType).toBe('image');
    expect(out!.text).toBe('look');
  });

  it('does not crash on unsupported attachments — marks them unknown', () => {
    const update: TelegramBotUpdate = {
      update_id: 3,
      message: {
        message_id: 8,
        date: 1700000200,
        chat: { id: 1, type: 'private' },
        sticker: { file_id: 'sx' },
      },
    };
    const out = normalizeInbound(ctx, update);
    expect(out!.messageType).toBe('unknown');
    expect(out!.text).toBe('');
  });

  it('returns null when the update has no actionable message', () => {
    const update = { update_id: 99 } as TelegramBotUpdate;
    expect(normalizeInbound(ctx, update)).toBeNull();
  });

  it('handles supergroup chats with negative ids', () => {
    const update: TelegramBotUpdate = {
      update_id: 4,
      message: {
        message_id: 100,
        date: 1700000300,
        chat: { id: -1001234567890, type: 'supergroup', title: 'Crew' },
        from: { id: 999, is_bot: false, first_name: 'Jo' },
        text: 'gm',
      },
    };
    const out = normalizeInbound(ctx, update);
    expect(out!.externalConversationId).toBe('-1001234567890');
    expect(out!.participant.chatType).toBe('supergroup');
    expect(out!.participantKey).toBe('telegram:tenant_a:acct_a:-1001234567890');
  });
});