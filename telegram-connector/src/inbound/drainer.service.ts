import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { DurableEventStoreService } from './durable-event-store.service';
import { SigcoreIngestService } from '../events/sigcore-ingest.service';

@Injectable()
export class DrainerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DrainerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly store: DurableEventStoreService,
    private readonly ingest: SigcoreIngestService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.scheduleNext();
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  private scheduleNext(): void {
    const interval = Number(process.env.TELEGRAM_DRAINER_INTERVAL_MS || 2000);
    this.timer = setTimeout(() => this.tick().catch((e) => this.logger.warn(e?.message)), interval);
  }

  /**
   * Single-flight: if a previous tick is still running, just skip and
   * reschedule. Prevents stacked ticks when one batch takes longer than
   * the interval.
   */
  async tick(): Promise<{ processed: number; sent: number; failed: number; dead: number }> {
    if (this.running) {
      this.scheduleNext();
      return { processed: 0, sent: 0, failed: 0, dead: 0 };
    }
    this.running = true;
    const result = { processed: 0, sent: 0, failed: 0, dead: 0 };

    try {
      const batchSize = Number(process.env.TELEGRAM_DRAINER_BATCH_SIZE || 20);
      const maxAttempts = Number(process.env.TELEGRAM_DRAINER_MAX_ATTEMPTS || 8);
      await this.store.recoverStuckProcessing(5 * 60_000);
      const rows = await this.store.claimBatch(batchSize);

      for (const row of rows) {
        result.processed++;
        try {
          await this.ingest.forwardInbound({
            workspaceId: row.tenantId,
            eventType: 'message_inbound',
            data: row.normalizedPayload,
          });
          await this.store.markSent(row.id);
          result.sent++;
        } catch (e: any) {
          const backoffMs = Math.min(60_000, 500 * Math.pow(2, row.attempts));
          const nextAttemptAt = new Date(Date.now() + backoffMs);
          const status = await this.store.markFailed(row.id, e?.message || 'unknown', {
            maxAttempts,
            nextAttemptAt,
          });
          if (status === 'dead') result.dead++;
          else result.failed++;
        }
      }
    } finally {
      this.running = false;
      if (process.env.NODE_ENV !== 'test') this.scheduleNext();
    }

    return result;
  }
}
