/**
 * Shared helper that decorates a message with the SF/public media contract.
 *
 * Contract (stable — frontends MUST read from message payload, not infer):
 *   hasMedia, mediaType, mediaMimetype, mediaFilename, mediaStatus, mediaUrl
 */

export type PublicMediaStatus =
  | 'downloaded'
  | 'skipped_too_large'
  | 'unsupported_store_message'
  | 'not_found'
  | 'failed';

export type PublicMediaType = 'image' | 'video' | 'audio' | 'document';

export interface MessageMediaFields {
  hasMedia: boolean;
  mediaType: PublicMediaType | null;
  mediaMimetype: string | null;
  mediaFilename: string | null;
  mediaStatus: PublicMediaStatus | null;
  mediaUrl: string | null;
}

export function deriveMediaType(mimetype?: string | null): PublicMediaType | null {
  if (!mimetype) return null;
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('video/')) return 'video';
  if (mimetype.startsWith('audio/')) return 'audio';
  return 'document';
}

/**
 * Deterministic hasMedia. Not implied — compute from metadata explicitly so
 * LID chats (no file yet) still surface a UI affordance.
 */
export function computeHasMedia(meta: Record<string, unknown>): boolean {
  const status = meta.mediaStatus as PublicMediaStatus | undefined;
  return Boolean(
    meta.mediaS3Key ||
    meta.mediaPath ||
    status === 'downloaded' ||
    status === 'unsupported_store_message',
  );
}

export function buildMediaFields(messageId: string, meta: Record<string, unknown>): MessageMediaFields {
  const hasMedia = computeHasMedia(meta);
  const mimetype = (meta.mediaMimetype as string) || null;
  const status = (meta.mediaStatus as PublicMediaStatus) || null;
  return {
    hasMedia,
    mediaType: hasMedia ? deriveMediaType(mimetype) : null,
    mediaMimetype: mimetype,
    mediaFilename: (meta.mediaFilename as string) || null,
    mediaStatus: status,
    mediaUrl: hasMedia ? `/conversations/messages/${messageId}/media` : null,
  };
}

/**
 * Merge media fields into a message entity/plain object for API responses.
 * Returns a new object with the decoration — input message is not mutated.
 */
export function decorateMessage<T extends { id: string; metadata?: unknown }>(
  message: T,
): T & MessageMediaFields {
  const meta = (message.metadata || {}) as Record<string, unknown>;
  return { ...message, ...buildMediaFields(message.id, meta) };
}
