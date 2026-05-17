import { Injectable } from '@nestjs/common';

/**
 * In-memory dedupe with bounded LRU eviction. Keys are short-lived: webhook
 * retries that need protection arrive within seconds, not days.
 *
 * Key shape: `${tenantId}|${accountId}|telegram|${externalMessageId}`
 * Fallback when no stable id is available:
 *   `${tenantId}|${accountId}|telegram|${chatId}:${msgId}:${timestamp}`
 */
@Injectable()
export class DedupeService {
  private readonly seen = new Map<string, number>();
  private readonly maxSize = 5000;
  private readonly ttlMs = 24 * 60 * 60 * 1000; // 24h

  key(parts: { tenantId: string; accountId: string; externalMessageId: string }): string {
    return `${parts.tenantId}|${parts.accountId}|telegram|${parts.externalMessageId}`;
  }

  fallbackKey(parts: {
    tenantId: string;
    accountId: string;
    telegramChatId: string;
    messageId: string | number;
    timestamp: string | number;
  }): string {
    return `${parts.tenantId}|${parts.accountId}|telegram|${parts.telegramChatId}:${parts.messageId}:${parts.timestamp}`;
  }

  /** Returns true if this is the first time we've seen `key`, false if duplicate. */
  observe(key: string): boolean {
    const now = Date.now();
    const prev = this.seen.get(key);
    if (prev !== undefined && now - prev < this.ttlMs) {
      // Refresh recency for LRU.
      this.seen.delete(key);
      this.seen.set(key, prev);
      return false;
    }
    this.seen.set(key, now);
    if (this.seen.size > this.maxSize) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return true;
  }

  size(): number {
    return this.seen.size;
  }
}