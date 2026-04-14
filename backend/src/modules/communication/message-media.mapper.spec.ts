import { decorateMessage, buildMediaFields, computeHasMedia, deriveMediaType } from './message-media.mapper';

describe('message-media.mapper', () => {
  describe('deriveMediaType', () => {
    it.each([
      ['image/jpeg', 'image'],
      ['image/png', 'image'],
      ['video/mp4', 'video'],
      ['audio/ogg', 'audio'],
      ['application/pdf', 'document'],
    ])('maps %s to %s', (mime, expected) => {
      expect(deriveMediaType(mime)).toBe(expected);
    });

    it('returns null for null/empty', () => {
      expect(deriveMediaType(null)).toBeNull();
      expect(deriveMediaType(undefined)).toBeNull();
      expect(deriveMediaType('')).toBeNull();
    });
  });

  describe('computeHasMedia', () => {
    it('true when mediaS3Key present', () => {
      expect(computeHasMedia({ mediaS3Key: 'whatsapp/ws/msg.jpg' })).toBe(true);
    });

    it('true when mediaPath present (legacy)', () => {
      expect(computeHasMedia({ mediaPath: 'whatsapp/ws/msg.jpg' })).toBe(true);
    });

    it('true when mediaStatus=downloaded even without key/path', () => {
      expect(computeHasMedia({ mediaStatus: 'downloaded' })).toBe(true);
    });

    it('true when mediaStatus=unsupported_store_message (LID chat conceptual media)', () => {
      expect(computeHasMedia({ mediaStatus: 'unsupported_store_message' })).toBe(true);
    });

    it('false for skipped_too_large (no UI placeholder by default)', () => {
      expect(computeHasMedia({ mediaStatus: 'skipped_too_large' })).toBe(false);
    });

    it('false for text-only message (empty metadata)', () => {
      expect(computeHasMedia({})).toBe(false);
    });
  });

  describe('buildMediaFields — SF contract', () => {
    it('includes mediaUrl pointing to stable endpoint when hasMedia', () => {
      const fields = buildMediaFields('msg-123', {
        mediaS3Key: 'whatsapp/ws/msg-123.jpg',
        mediaMimetype: 'image/jpeg',
        mediaFilename: 'photo.jpg',
        mediaStatus: 'downloaded',
      });
      expect(fields).toEqual({
        hasMedia: true,
        mediaType: 'image',
        mediaMimetype: 'image/jpeg',
        mediaFilename: 'photo.jpg',
        mediaStatus: 'downloaded',
        mediaUrl: '/conversations/messages/msg-123/media',
      });
    });

    it('LID chat: hasMedia=true and mediaUrl set even without file', () => {
      const fields = buildMediaFields('msg-lid', {
        mediaStatus: 'unsupported_store_message',
      });
      expect(fields.hasMedia).toBe(true);
      expect(fields.mediaUrl).toBe('/conversations/messages/msg-lid/media');
      expect(fields.mediaType).toBeNull(); // no mimetype
    });

    it('text-only message: all null/false', () => {
      const fields = buildMediaFields('msg-text', {});
      expect(fields).toEqual({
        hasMedia: false,
        mediaType: null,
        mediaMimetype: null,
        mediaFilename: null,
        mediaStatus: null,
        mediaUrl: null,
      });
    });
  });

  describe('decorateMessage', () => {
    it('does not mutate input message', () => {
      const input = { id: 'm1', body: 'hi', metadata: { mediaS3Key: 'k' } };
      const out = decorateMessage(input as any);
      expect(input).not.toHaveProperty('hasMedia');
      expect(out.hasMedia).toBe(true);
      expect(out.body).toBe('hi');
    });

    it('handles message with undefined metadata', () => {
      const out = decorateMessage({ id: 'm2' } as any);
      expect(out.hasMedia).toBe(false);
      expect(out.mediaUrl).toBeNull();
    });
  });
});
