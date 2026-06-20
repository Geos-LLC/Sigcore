import { Injectable } from '@nestjs/common';

interface CacheEntry {
  verdict: Record<string, unknown>;
  expiresAt: number;
}

@Injectable()
export class VerifyCache {
  private readonly store = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor() {
    this.ttlMs = parseInt(process.env.TELEGRAM_VERIFY_CACHE_TTL_MS || '3600000', 10);
    this.maxEntries = parseInt(process.env.TELEGRAM_VERIFY_CACHE_MAX_ENTRIES || '5000', 10);
  }

  private key(workspaceId: string, chatRef: string): string {
    return `${workspaceId}:${chatRef.toLowerCase()}`;
  }

  get(workspaceId: string, chatRef: string): Record<string, unknown> | null {
    const k = this.key(workspaceId, chatRef);
    const entry = this.store.get(k);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(k);
      return null;
    }
    return entry.verdict;
  }

  set(workspaceId: string, chatRef: string, verdict: Record<string, unknown>): void {
    if (this.store.size >= this.maxEntries) {
      // FIFO eviction — drop the oldest insertion (Map iteration is insertion-order).
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) this.store.delete(firstKey);
    }
    this.store.set(this.key(workspaceId, chatRef), {
      verdict,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  size(): number {
    return this.store.size;
  }
}
