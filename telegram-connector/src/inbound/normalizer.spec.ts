import { fallbackDedupeKey, normalize, participantKey } from './normalizer';

const baseUpdate = (overrides: Record<string, unknown> = {}) => ({
  update_id: 100,
  message: {
    message_id: 42,
    from: { id: 7777, first_name: 'Ada', last_name: 'Lovelace', username: 'ada' },
    chat: { id: -1001234567890, type: 'supergroup' as const, title: 'Eng' },
    date: 1700000000,
    text: 'hello',
    ...overrides,
  },
});

describe('normalize', () => {
  it('produces canonical participant key and ids for a supergroup message', () => {
    const { message } = normalize(baseUpdate(), { tenantId: 't1', accountId: 'a1' });
    expect(message).not.toBeNull();
    expect(message!.participantKey).toBe('telegram:t1:a1:-1001234567890');
    expect(message!.externalMessageId).toBe('42');
    expect(message!.externalConversationId).toBe('-1001234567890');
    expect(message!.messageType).toBe('text');
    expect(message!.text).toBe('hello');
    expect(message!.providerMetadata.chatType).toBe('supergroup');
    expect(message!.providerMetadata.username).toBe('ada');
    expect(message!.providerMetadata.displayName).toBe('Ada Lovelace');
  });

  it('classifies attachments without crashing on missing text', () => {
    const photo = normalize(baseUpdate({ text: undefined, photo: [{}] }), { tenantId: 't1', accountId: 'a1' });
    const voice = normalize(baseUpdate({ text: undefined, voice: {} }), { tenantId: 't1', accountId: 'a1' });
    const doc = normalize(baseUpdate({ text: undefined, document: {} }), { tenantId: 't1', accountId: 'a1' });
    const video = normalize(baseUpdate({ text: undefined, video: {} }), { tenantId: 't1', accountId: 'a1' });
    const unknown = normalize(baseUpdate({ text: undefined }), { tenantId: 't1', accountId: 'a1' });

    expect(photo.message!.messageType).toBe('image');
    expect(voice.message!.messageType).toBe('voice');
    expect(doc.message!.messageType).toBe('file');
    expect(video.message!.messageType).toBe('video');
    expect(unknown.message!.messageType).toBe('unknown');
  });

  it('falls back to caption as text', () => {
    const result = normalize(baseUpdate({ text: undefined, photo: [{}], caption: 'caption-here' }), {
      tenantId: 't1', accountId: 'a1',
    });
    expect(result.message!.text).toBe('caption-here');
  });

  it('returns null when update carries no message body', () => {
    const result = normalize({ update_id: 1 } as any, { tenantId: 't1', accountId: 'a1' });
    expect(result.message).toBeNull();
  });

  it('builds deterministic fallback dedupe key', () => {
    const update = baseUpdate();
    const key = fallbackDedupeKey(update.message as any);
    expect(key).toBe('-1001234567890:42:1700000000');
  });
});

describe('participantKey', () => {
  it('formats with tenant and account scoping', () => {
    expect(participantKey('t', 'a', 999)).toBe('telegram:t:a:999');
  });
});
