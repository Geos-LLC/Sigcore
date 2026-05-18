import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DurableEventStoreService } from './durable-event-store.service';
import { SigcoreIngestService } from '../events/sigcore-ingest.service';
import { DurableInboundEvent } from './inbound.types';

/**
 * Polling drainer: claims `pending` events, forwards each to Sigcore, and
 * advances the event through the status machine.
 *
 *   sent     → success
 *   pending  → retry with exponential back-off
 *   dead     → exceeded max attempts (also emits a terminal `message.failed`)
 *
 * Single-flight tick — overlapping ticks are skipped so a slow Sigcore can't
 * make us pile concurrent forwards on the same events.
 */
@Injectable()
export class DrainerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DrainerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly intervalMs: number;
  private readonly batch: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly store: DurableEventStoreService,
    private readonly ingest: SigcoreIngestService,
  ) {
    this.intervalMs = parseInt(process.env.TELEGRAM_DRAINER_INTERVAL_MS || '2000', 10) || 2000;
    this.batch = parseInt(process.env.TELEGRAM_DRAINER_BATCH || '20', 10) || 20;
    this.maxAttempts = parseInt(process.env.TELEGRAM_DRAINER_MAX_ATTEMPTS || '8', 10) || 8;
  }

  onModuleInit() {
    if (process.env.TELEGRAM_DRAINER_DISABLED === 'true') {
      this.logger.warn('drainer disabled via TELEGRAM_DRAINER_DISABLED');
      return;
    }
    this.timer = setInterval(() => this.tick().catch((e) => this.logger.error(`tick failed: ${e?.message}`)), this.intervalMs);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const events = await this.store.listReady(this.batch);
      for (const ev of events) {
        await this.process(ev);
      }
    } finally {
      this.running = false;
    }
  }

  async process(event: DurableInboundEvent): Promise<void> {
    const claimed = await this.store.claim(event);
    if (!claimed) return;
    try {
      await this.ingest.forwardInbound(claimed.normalizedPayload);
      await this.store.markSent(claimed);
      await this.ingest.emitProviderEvent({
        eventType: 'message.received',
        tenantId: claimed.tenantId,
        accountId: claimed.accountId,
        occurredAt: new Date().toISOString(),
        data: {
          externalMessageId: claimed.externalMessageId,
          externalConversationId: claimed.externalConversationId,
          participantKey: claimed.participantKey,
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown_error';
      if (claimed.attempts >= this.maxAttempts) {
        await this.store.markDead(claimed, msg);
        await this.ingest.emitProviderEvent({
          eventType: 'message.failed',
          tenantId: claimed.tenantId,
          accountId: claimed.accountId,
          occurredAt: new Date().toISOString(),
          data: {
            terminal: true,
            externalMessageId: claimed.externalMessageId,
            externalConversationId: claimed.externalConversationId,
            error: msg,
          },
        });
      } else {
        const backoffMs = Math.min(60_000, 500 * Math.pow(2, claimed.attempts - 1));
        await this.store.markRetry(claimed, msg, backoffMs);
      }
    }
  }
}
