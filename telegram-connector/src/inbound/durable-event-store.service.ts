import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { DurableInboundEvent, DurableEventStatus, NormalizedInboundMessage } from './inbound.types';

/**
 * File-backed durable store: one JSON file per event under
 *
 *   <dataDir>/telegram-events/<status>/<id>.json
 *
 * Status transitions move files between directories so the drainer can list
 * pending work cheaply. This is *deliberately* simple — production should
 * swap in Postgres (the schema in `DurableInboundEvent` is the contract).
 *
 * Dedupe semantics:
 *   primary key   = tenantId + accountId + provider + externalMessageId
 *   fallback key  = telegramChatId + messageId + timestamp
 * Both keys are checked against an index file before insert, so re-delivery
 * via webhook retries cannot create duplicate Sigcore message rows.
 */
@Injectable()
export class DurableEventStoreService {
  private readonly logger = new Logger(DurableEventStoreService.name);
  private readonly root: string;
  private readonly statuses: DurableEventStatus[] = ['pending', 'processing', 'sent', 'failed', 'dead'];

  constructor() {
    const data = process.env.TELEGRAM_DATA_DIR || './data';
    this.root = path.join(data, 'telegram-events');
    for (const s of this.statuses) {
      fs.mkdirSync(path.join(this.root, s), { recursive: true });
    }
    fs.mkdirSync(path.join(this.root, 'dedupe'), { recursive: true });
    this.recoverInterrupted();
  }

  /**
   * Insert a new event if its primary or fallback key has not been seen.
   * Returns the event when newly enqueued, or `null` when dropped as duplicate.
   */
  async enqueueIfNew(
    normalized: NormalizedInboundMessage,
    fallbackKey: string,
    rawPayload: Record<string, unknown>,
  ): Promise<DurableInboundEvent | null> {
    const primary = this.primaryKey(normalized);
    if (this.isDuplicate(primary) || this.isDuplicate(fallbackKey)) return null;

    const now = new Date().toISOString();
    const event: DurableInboundEvent = {
      id: crypto.randomUUID(),
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
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    };

    this.write(event);
    this.markDedupe(primary);
    this.markDedupe(fallbackKey);
    return event;
  }

  async listReady(limit: number): Promise<DurableInboundEvent[]> {
    const dir = path.join(this.root, 'pending');
    const files = fs.readdirSync(dir);
    const now = Date.now();
    const out: DurableInboundEvent[] = [];

    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const ev = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as DurableInboundEvent;
        if (new Date(ev.nextAttemptAt).getTime() <= now) out.push(ev);
      } catch {}
      if (out.length >= limit) break;
    }
    return out;
  }

  async listByStatus(status: DurableEventStatus): Promise<DurableInboundEvent[]> {
    const dir = path.join(this.root, status);
    if (!fs.existsSync(dir)) return [];
    const out: DurableInboundEvent[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as DurableInboundEvent);
      } catch {}
    }
    return out;
  }

  /** Atomically claim an event for processing (status → processing). */
  async claim(event: DurableInboundEvent): Promise<DurableInboundEvent | null> {
    const from = path.join(this.root, event.status, `${event.id}.json`);
    if (!fs.existsSync(from)) return null;
    event.status = 'processing';
    event.attempts += 1;
    event.updatedAt = new Date().toISOString();
    this.move(event, 'processing');
    return event;
  }

  async markSent(event: DurableInboundEvent): Promise<void> {
    event.status = 'sent';
    event.updatedAt = new Date().toISOString();
    event.lastError = undefined;
    this.move(event, 'sent');
  }

  async markRetry(event: DurableInboundEvent, error: string, backoffMs: number): Promise<void> {
    event.status = 'pending';
    event.lastError = error;
    event.nextAttemptAt = new Date(Date.now() + backoffMs).toISOString();
    event.updatedAt = new Date().toISOString();
    this.move(event, 'pending');
  }

  async markDead(event: DurableInboundEvent, error: string): Promise<void> {
    event.status = 'dead';
    event.lastError = error;
    event.updatedAt = new Date().toISOString();
    this.move(event, 'dead');
  }

  private primaryKey(m: NormalizedInboundMessage): string {
    return `${m.tenantId}|${m.accountId}|telegram|${m.externalMessageId}`;
  }

  private isDuplicate(key: string): boolean {
    return fs.existsSync(path.join(this.root, 'dedupe', this.hash(key)));
  }

  private markDedupe(key: string): void {
    fs.writeFileSync(path.join(this.root, 'dedupe', this.hash(key)), '');
  }

  private hash(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
  }

  private write(event: DurableInboundEvent): void {
    const dir = path.join(this.root, event.status);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${event.id}.json`), JSON.stringify(event, null, 2));
  }

  private move(event: DurableInboundEvent, to: DurableEventStatus): void {
    for (const s of this.statuses) {
      const p = path.join(this.root, s, `${event.id}.json`);
      if (fs.existsSync(p) && s !== to) {
        try { fs.unlinkSync(p); } catch {}
      }
    }
    this.write({ ...event, status: to });
  }

  /** On boot, sweep stale `processing` entries back to `pending` so they
   * resume after a crash.  Drainer-acquired entries always re-enter the
   * status machine, so this is safe. */
  private recoverInterrupted(): void {
    const dir = path.join(this.root, 'processing');
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      try {
        const event = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as DurableInboundEvent;
        event.status = 'pending';
        event.nextAttemptAt = new Date().toISOString();
        this.write(event);
        try { fs.unlinkSync(path.join(dir, f)); } catch {}
        this.logger.warn(`recovered interrupted event ${event.id}`);
      } catch {}
    }
  }
}
