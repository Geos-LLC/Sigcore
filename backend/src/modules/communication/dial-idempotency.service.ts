import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

/**
 * Wave-2 Phase C — in-process idempotency store for outbound-dial requests.
 *
 * Contract:
 *   claim(workspaceId, key, bodyHash, response?)
 *     → { status: 'new' }              first time seen — caller creates + calls remember()
 *     → { status: 'match', response }  same key + same body → return cached response
 *     → { status: 'conflict' }         same key + different body → 409
 *
 *   remember(workspaceId, key, response)
 *     stores the response so future same-key/same-body claims return it.
 *
 * Storage: in-memory Map with TTL cleanup. Fine for the current pilot
 * (Sigcore prod deploys with numReplicas=1 per its Railway config, so a
 * single process is authoritative). Follow-up before scaling out: back
 * this with Redis / a `dial_idempotency` DB table.
 */
export interface DialIdempotencyClaim {
  status: 'new' | 'match' | 'conflict';
  response?: unknown;
}

interface Entry {
  bodyHash: string;
  response?: unknown;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15min
const MAX_KEYS = 10_000; // hard upper bound to prevent memory bloat

@Injectable()
export class DialIdempotencyService {
  private readonly logger = new Logger(DialIdempotencyService.name);
  private readonly store = new Map<string, Entry>();
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    // Best-effort periodic cleanup. Cheap map iteration; runs every 15min.
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), CLEANUP_INTERVAL_MS);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  /** Compute a stable hash over the caller's canonicalized body. */
  static hashBody(body: unknown): string {
    // Sort keys deterministically — client shouldn't get charged for JSON key
    // order noise.
    const canonical = JSON.stringify(body, Object.keys(body as object).sort());
    return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
  }

  /**
   * Atomically decide whether to accept this request as new, replay a
   * cached response, or reject as conflicting.
   */
  claim(
    workspaceId: string,
    idempotencyKey: string,
    bodyHash: string,
  ): DialIdempotencyClaim {
    const key = this.buildKey(workspaceId, idempotencyKey);
    const now = Date.now();
    const existing = this.store.get(key);
    if (existing) {
      if (existing.expiresAt < now) {
        this.store.delete(key);
      } else if (existing.bodyHash !== bodyHash) {
        return { status: 'conflict' };
      } else {
        return { status: 'match', response: existing.response };
      }
    }
    // Reserve the slot with the body hash but no response yet. The caller
    // completes the reservation via remember() once Twilio returns.
    this.store.set(key, {
      bodyHash,
      response: undefined,
      expiresAt: now + DEFAULT_TTL_MS,
    });
    this.enforceSizeCap();
    return { status: 'new' };
  }

  remember(
    workspaceId: string,
    idempotencyKey: string,
    bodyHash: string,
    response: unknown,
  ): void {
    const key = this.buildKey(workspaceId, idempotencyKey);
    this.store.set(key, {
      bodyHash,
      response,
      expiresAt: Date.now() + DEFAULT_TTL_MS,
    });
  }

  /** Release the reservation without storing a response (e.g. on error). */
  release(workspaceId: string, idempotencyKey: string): void {
    this.store.delete(this.buildKey(workspaceId, idempotencyKey));
  }

  private buildKey(workspaceId: string, idempotencyKey: string): string {
    return `${workspaceId}:${idempotencyKey}`;
  }

  private cleanupExpired(): void {
    const now = Date.now();
    let removed = 0;
    for (const [k, v] of this.store.entries()) {
      if (v.expiresAt < now) {
        this.store.delete(k);
        removed++;
      }
    }
    if (removed > 0) {
      this.logger.debug(`dial_idempotency_cleanup removed=${removed}`);
    }
  }

  private enforceSizeCap(): void {
    if (this.store.size <= MAX_KEYS) return;
    // Remove the oldest ~10% by iteration order (Map iterates insertion order).
    const toRemove = Math.floor(MAX_KEYS * 0.1);
    let removed = 0;
    for (const k of this.store.keys()) {
      this.store.delete(k);
      removed++;
      if (removed >= toRemove) break;
    }
    this.logger.warn(
      `dial_idempotency size cap exceeded — evicted ${removed} oldest entries. Consider migrating to Redis.`,
    );
  }
}
