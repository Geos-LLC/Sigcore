import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  InboundEventRecord,
  InboundEventStatus,
  NormalizedInboundMessage,
} from './types';

/**
 * Durable store for inbound Telegram events (`telegram_inbound_events` in the
 * issue spec). Stores one JSON file per event under
 * `data/telegram-events/<status>/<id>.json`, with status mirrored in both the
 * filename and the file path so a directory listing tells you what needs
 * attention.
 *
 * Idempotency primary key:
 *   tenantId + accountId + provider + externalMessageId
 *
 * Fallback when the upstream id is unstable:
 *   telegramChatId + messageId + timestamp
 *
 * This is intentionally a thin filesystem implementation — once Sigcore wires
 * a shared Postgres/Redis-backed queue we swap this out behind the same
 * interface. The semantics here (visible status transitions, attempts counter,
 * dead-letter terminal state) are the contract.
 */
@Injectable()
export class InboundEventsStore {
  private readonly logger = new Logger(InboundEventsStore.name);
  private readonly root: string;
  /** Composite-key index → event id so dedupe is O(1). */
  private readonly keyIndex = new Map<string, string>();
  private readonly events = new Map<string, InboundEventRecord>();

  constructor() {
    this.root = path.join(process.cwd(), 'data', 'telegram-events');
    this.load();
  }

  private statusDir(status: InboundEventStatus): string {
    return path.join(this.root, status);
  }

  private filePath(record: InboundEventRecord): string {
    return path.join(this.statusDir(record.status), `${record.id}.json`);
  }

  private compositeKey(parts: {
    tenantId: string;
    accountId: string;
    externalMessageId: string;
  }): string {
    return `${parts.tenantId}|${parts.accountId}|telegram|${parts.externalMessageId}`;
  }

  private load() {
    try {
      if (!fs.existsSync(this.root)) return;
      for (const status of ['pending', 'processing', 'sent', 'failed', 'dead'] as InboundEventStatus[]) {
        const dir = this.statusDir(status);
        if (!fs.existsSync(dir)) continue;
        for (const name of fs.readdirSync(dir)) {
          if (!name.endsWith('.json')) continue;
          try {
            const raw = fs.readFileSync(path.join(dir, name), 'utf8');
            const rec = JSON.parse(raw) as InboundEventRecord;
            this.events.set(rec.id, rec);
            this.keyIndex.set(
              this.compositeKey({
                tenantId: rec.tenantId,
                accountId: rec.accountId,
                externalMessageId: rec.externalMessageId,
              }),
              rec.id,
            );
          } catch (err) {
            this.logger.warn(`Skipping unreadable event file ${name}: ${(err as Error).message}`);
          }
        }
      }
      this.logger.log(`Loaded ${this.events.size} inbound events from disk`);
      // Recovery: processing entries from a prior crash should reset to pending.
      for (const rec of this.events.values()) {
        if (rec.status === 'processing') {
          this.transition(rec, 'pending', { reason: 'recovered_from_crash' });
        }
      }
    } catch (err) {
      this.logger.warn(`Failed to load inbound events: ${(err as Error).message}`);
    }
  }

  private persist(rec: InboundEventRecord) {
    const dir = this.statusDir(rec.status);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath(rec), JSON.stringify(rec, null, 2), { mode: 0o600 });
  }

  private removeFile(rec: InboundEventRecord, oldStatus: InboundEventStatus) {
    const old = path.join(this.statusDir(oldStatus), `${rec.id}.json`);
    try { fs.unlinkSync(old); } catch { /* swallow ENOENT */ }
  }

  /**
   * Enqueue a normalized inbound event.
   *
   * Returns `{ enqueued: true, record }` on first insert, or
   * `{ enqueued: false, record }` if the composite key has already been seen
   * (duplicate inbound). Duplicate detection is the durable dedupe contract.
   */
  enqueue(normalized: NormalizedInboundMessage, rawPayload: Record<string, unknown>): {
    enqueued: boolean;
    record: InboundEventRecord;
  } {
    const key = this.compositeKey({
      tenantId: normalized.tenantId,
      accountId: normalized.accountId,
      externalMessageId: normalized.externalMessageId,
    });
    const existingId = this.keyIndex.get(key);
    if (existingId) {
      const existing = this.events.get(existingId)!;
      return { enqueued: false, record: existing };
    }

    const id = `evt_${crypto.randomBytes(10).toString('hex')}`;
    const now = new Date().toISOString();
    const rec: InboundEventRecord = {
      id,
      tenantId: normalized.tenantId,
      accountId: normalized.accountId,
      provider: 'telegram',
      externalMessageId: normalized.externalMessageId,
      externalConversationId: normalized.externalConversationId,
      participantKey: normalized.participantKey,
      payload: rawPayload,
      normalizedPayload: normalized,
      status: 'pending',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: now,
    };
    this.events.set(id, rec);
    this.keyIndex.set(key, id);
    this.persist(rec);
    return { enqueued: true, record: rec };
  }

  /**
   * Claim up to `limit` pending events for processing. Each returned event is
   * atomically transitioned to `processing` and its `attempts` counter
   * incremented so a concurrent drainer pass cannot pick it up twice.
   *
   * `now` is the wall clock; events with `nextAttemptAt > now` are skipped
   * (back-off honored).
   */
  claimBatch(limit: number, now = new Date()): InboundEventRecord[] {
    const nowIso = now.toISOString();
    const out: InboundEventRecord[] = [];
    for (const rec of this.events.values()) {
      if (out.length >= limit) break;
      if (rec.status !== 'pending') continue;
      if (rec.nextAttemptAt && rec.nextAttemptAt > nowIso) continue;
      rec.attempts += 1;
      this.transition(rec, 'processing', { reason: 'claimed_for_drain' });
      out.push(rec);
    }
    return out;
  }

  markSent(id: string) {
    const rec = this.events.get(id);
    if (!rec) return;
    rec.lastError = undefined;
    this.transition(rec, 'sent', { reason: 'forwarded_to_sigcore' });
  }

  /**
   * Mark a processing event as failed and re-queue for retry, or dead-letter
   * if attempts have hit the cap.
   *
   * `maxAttempts` is the hard ceiling — once attempts reach this number the
   * event terminates in `dead`. The drainer is responsible for surfacing
   * dead-letter to an operator-visible signal (logs today; metric later).
   */
  markFailed(id: string, error: string, maxAttempts: number, backoffMs: number) {
    const rec = this.events.get(id);
    if (!rec) return;
    rec.lastError = error;
    if (rec.attempts >= maxAttempts) {
      this.transition(rec, 'dead', { reason: 'max_attempts_exceeded' });
      this.logger.warn(
        `[telegram] dead-letter event=${rec.id} tenant=${rec.tenantId} ` +
          `account=${rec.accountId} message=${rec.externalMessageId} attempts=${rec.attempts}`,
      );
      return;
    }
    rec.nextAttemptAt = new Date(Date.now() + backoffMs * Math.pow(2, rec.attempts - 1)).toISOString();
    this.transition(rec, 'pending', { reason: 'requeued_for_retry' });
  }

  private transition(
    rec: InboundEventRecord,
    next: InboundEventStatus,
    _meta: { reason: string },
  ) {
    const prev = rec.status;
    if (prev === next) {
      rec.updatedAt = new Date().toISOString();
      this.persist(rec);
      return;
    }
    this.removeFile(rec, prev);
    rec.status = next;
    rec.updatedAt = new Date().toISOString();
    this.persist(rec);
  }

  get(id: string): InboundEventRecord | undefined {
    return this.events.get(id);
  }

  countByStatus(): Record<InboundEventStatus, number> {
    const out: Record<InboundEventStatus, number> = {
      pending: 0, processing: 0, sent: 0, failed: 0, dead: 0,
    };
    for (const rec of this.events.values()) out[rec.status] += 1;
    return out;
  }

  listDead(tenantId?: string): InboundEventRecord[] {
    const result: InboundEventRecord[] = [];
    for (const rec of this.events.values()) {
      if (rec.status !== 'dead') continue;
      if (tenantId && rec.tenantId !== tenantId) continue;
      result.push(rec);
    }
    return result;
  }
}
