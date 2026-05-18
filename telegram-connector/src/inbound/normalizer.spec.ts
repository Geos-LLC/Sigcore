import { normalizeUpdate } from './normalizer';

const CTX = { tenantId: 'ten_1', accountId: 'acct_1' };

describe('normalizer', () => {
  it('normalizes a private text message', () => {
    const out = normalizeUpdate(
      {
        update_id: 1,
        message: {
          message_id: 42,
          date: 1716000000,
          text: 'Hi',
          from: { id: 789, username: 'alice', first_name: 'Alice' },
          chat: { id: 789, type: 'private', first_name: 'Alice' },
        },
      },
      CTX,
    );

    expect(out).toBeTruthy();
    expect(out!.externalMessageId).toBe('789:42');
    expect(out!.externalConversationId).toBe('789');
    expect(out!.participantKey).toBe('telegram:ten_1:acct_1:789');
    expect(out!.messageType).toBe('text');
    expect(out!.text).toBe('Hi');
    expect(out!.providerMetadata.chatType).toBe('private');
    expect(out!.providerMetadata.username).toBe('alice');
  });

  it('normalizes a supergroup message with caption-only', () => {
    const out = normalizeUpdate(
      {
        message: {
          message_id: 100,
          date: 1716000000,
          caption: 'see pic',
          photo: [{}],
          from: { id: 111, first_name: 'Bob' },
          chat: { id: -1001234567890, type: 'supergroup', title: 'Group' },
        } as any,
      },
      CTX,
    );
    expect(out!.externalConversationId).toBe('-1001234567890');
    expect(out!.messageType).toBe('image');
    expect(out!.text).toBe('see pic');
    expect(out!.providerMetadata.displayName).toBe('Bob');
  });

  it('classifies unsupported message types as unknown without crashing', () => {
    const out = normalizeUpdate(
      {
        message: {
          message_id: 5,
          date: 1716000000,
          from: { id: 1, first_name: 'X' },
          chat: { id: 1, type: 'private' },
        },
      },
      CTX,
    );
    expect(out!.messageType).toBe('unknown');
    expect(out!.text).toBe('');
  });

  it('returns null when the update has no message', () => {
    expect(normalizeUpdate({ update_id: 1 } as any, CTX)).toBeNull();
  });

  it('uses edited_message when message is absent', () => {
    const out = normalizeUpdate(
      {
        edited_message: {
          message_id: 9,
          date: 1716000000,
          text: 'edited',
          from: { id: 2, first_name: 'X' },
          chat: { id: 2, type: 'private' },
        },
      },
      CTX,
    );
    expect(out!.text).toBe('edited');
  });
});
