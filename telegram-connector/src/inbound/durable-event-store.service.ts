import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository, IsNull } from 'typeorm';
import { InboundEventStatus, TelegramInboundEvent } from './telegram-inbound-event.entity';

export interface EnqueueInput {
  tenantId: string;
  accountId: string;
  externalMessageId: string;
  externalConversationId: string;
  participantKey: string;
  payload: Record<string, unknown>;
  normalizedPayload: Record<string, unknown>;
}

@Injectable()
export class DurableEventStoreService {
  private readonly logger = new Logger(DurableEventStoreService.name);

  constructor(
    @InjectRepository(TelegramInboundEvent)
    private readonly repo: Repository<TelegramInboundEvent>,
  ) {}

  /**
   * Idempotent insert keyed on (tenantId, accountId, externalMessageId).
   * Returns the row whether inserted or already present — callers treat both
   * cases as success.
   */
  async enqueue(input: EnqueueInput): Promise<TelegramInboundEvent> {
    try {
      const row = this.repo.create({
        tenantId: input.tenantId,
        accountId: input.accountId,
        provider: 'telegram',
        externalMessageId: input.externalMessageId,
        externalConversationId: input.externalConversationId,
        participantKey: input.participantKey,
        payload: input.payload,
        normalizedPayload: input.normalizedPayload,
        status: 'pending',
        attempts: 0,
      });
      return await this.repo.save(row);
    } catch (e: any) {
      // Unique constraint on (tenantId, accountId, externalMessageId) — duplicate.
      if (e.code === '23505') {
        const existing = await this.repo.findOne({
          where: {
            tenantId: input.tenantId,
            accountId: input.accountId,
            externalMessageId: input.externalMessageId,
          },
        });
        if (existing) return existing;
      }
      throw e;
    }
  }

  /**
   * Claim a batch of due events for processing. Uses SKIP LOCKED so multiple
   * connector replicas can drain concurrently without stepping on each other.
   * Falls back to a non-locking find for tests/sqlite where the dialect
   * doesn't support FOR UPDATE.
   */
  async claimBatch(batchSize: number, now: Date = new Date()): Promise<TelegramInboundEvent[]> {
    const qb = this.repo
      .createQueryBuilder('e')
      .where('e.status = :pending', { pending: 'pending' })
      .andWhere('(e.next_attempt_at IS NULL OR e.next_attempt_at <= :now)', { now })
      .orderBy('e.created_at', 'ASC')
      .limit(batchSize);

    try {
      qb.setLock('pessimistic_write').setOnLocked('skip_locked');
    } catch {
      // dialect doesn't support — fine, just less concurrent-safe in tests.
    }

    const rows = await qb.getMany();
    if (rows.length === 0) return rows;

    await this.repo.update(
      { id: rows[0]!.id as any },
      { status: 'processing', attempts: () => 'attempts + 1' as any } as any,
    );
    // Bulk patch the rest individually — simple and clear.
    for (const r of rows) {
      r.status = 'processing';
      r.attempts = (r.attempts || 0) + 1;
      await this.repo.update({ id: r.id }, { status: r.status, attempts: r.attempts });
    }
    return rows;
  }

  async markSent(id: string): Promise<void> {
    await this.repo.update({ id }, { status: 'sent', lastError: null as any });
  }

  async markFailed(id: string, error: string, opts: { maxAttempts: number; nextAttemptAt: Date }): Promise<InboundEventStatus> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) return 'failed';

    const status: InboundEventStatus = row.attempts >= opts.maxAttempts ? 'dead' : 'pending';
    await this.repo.update(
      { id },
      {
        status,
        lastError: error,
        nextAttemptAt: status === 'pending' ? opts.nextAttemptAt : null,
      } as any,
    );
    return status;
  }

  async listDead(limit = 100): Promise<TelegramInboundEvent[]> {
    return this.repo.find({ where: { status: 'dead' }, take: limit, order: { updatedAt: 'DESC' } });
  }

  async recoverStuckProcessing(stuckThresholdMs: number, now: Date = new Date()): Promise<number> {
    // If a row sat in 'processing' for too long the connector probably crashed
    // mid-process — re-queue it.
    const threshold = new Date(now.getTime() - stuckThresholdMs);
    const result = await this.repo
      .createQueryBuilder()
      .update()
      .set({ status: 'pending', nextAttemptAt: now } as any)
      .where('status = :p AND updated_at <= :t', { p: 'processing', t: threshold })
      .execute();
    return result.affected || 0;
  }
}
