import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InboundEventsStore } from './inbound-events.store';
import { SigcoreIngestService } from './sigcore-ingest.service';
import { EventBusService } from './event-bus.service';

/**
 * Periodic drainer for the durable inbound event store.
 *
 *   pending → processing  (claimBatch atomically increments attempts)
 *   processing → sent     (Sigcore ingest succeeded)
 *   processing → pending  (transient failure, back-off scheduled)
 *   processing → dead     (attempts hit the cap)
 *
 * Two side-effects per success:
 *   1. POST to Sigcore /webhooks/telegram/inbound (the message payload)
 *   2. EventBus emit `message.received` + `conversation.updated` (signals)
 *
 * Failures emit `message.failed` on the event bus so downstream products
 * can react to dead-letter pressure without scraping the store directly.
 */
@Injectable()
export class DrainerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DrainerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;

  constructor(
    private readonly store: InboundEventsStore,
    private readonly ingest: SigcoreIngestService,
    private readonly events: EventBusService,
  ) {
    this.intervalMs = Number(process.env.TELEGRAM_DRAINER_INTERVAL_MS) || 2000;
    this.batchSize = Number(process.env.TELEGRAM_DRAINER_BATCH_SIZE) || 25;
    this.maxAttempts = Number(process.env.TELEGRAM_DRAINER_MAX_ATTEMPTS) || 8;
    this.backoffMs = 2000;
  }

  onModuleInit() {
    if (process.env.TELEGRAM_DRAINER_DISABLED === 'true') {
      this.logger.log('Drainer disabled by TELEGRAM_DRAINER_DISABLED=true');
      return;
    }
    this.start();
  }

  onModuleDestroy() {
    this.stop();
  }

  start() {
    if (this.timer) return;
    this.logger.log(
      `Drainer started — interval=${this.intervalMs}ms batch=${this.batchSize} maxAttempts=${this.maxAttempts}`,
    );
    this.timer = setInterval(() => {
      this.tick().catch(err =>
        this.logger.warn(`Drainer tick crashed: ${err instanceof Error ? err.message : 'unknown'}`),
      );
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Process a single batch. Exposed for tests so they can drive it deterministically. */
  async tick(): Promise<{ processed: number; sent: number; failed: number; dead: number }> {
    if (this.running) return { processed: 0, sent: 0, failed: 0, dead: 0 };
    this.running = true;
    let sent = 0;
    let failed = 0;
    let dead = 0;
    try {
      const batch = this.store.claimBatch(this.batchSize);
      for (const rec of batch) {
        const fwd = await this.ingest.forward('message_inbound', rec.normalizedPayload);
        if (fwd.ok) {
          this.store.markSent(rec.id);
          sent += 1;
          // Fire-and-forget — bus failures must not block ingest progress.
          this.events.emit('message.received', {
            tenantId: rec.tenantId,
            accountId: rec.accountId,
            data: {
              externalMessageId: rec.externalMessageId,
              externalConversationId: rec.externalConversationId,
              participantKey: rec.participantKey,
              messageType: rec.normalizedPayload.messageType,
              timestamp: rec.normalizedPayload.timestamp,
            },
          }).catch(() => {/* logged inside */});
          this.events.emit('conversation.updated', {
            tenantId: rec.tenantId,
            accountId: rec.accountId,
            data: {
              externalConversationId: rec.externalConversationId,
              participantKey: rec.participantKey,
              lastMessageAt: rec.normalizedPayload.timestamp,
            },
          }).catch(() => {/* logged inside */});
        } else {
          const willBeDead = rec.attempts >= this.maxAttempts;
          this.store.markFailed(rec.id, fwd.error || 'unknown', this.maxAttempts, this.backoffMs);
          if (willBeDead) {
            dead += 1;
            this.events.emit('message.failed', {
              tenantId: rec.tenantId,
              accountId: rec.accountId,
              data: {
                externalMessageId: rec.externalMessageId,
                error: fwd.error,
                attempts: rec.attempts,
                terminal: true,
              },
            }).catch(() => {/* logged inside */});
          } else {
            failed += 1;
          }
        }
      }
      return { processed: batch.length, sent, failed, dead };
    } finally {
      this.running = false;
    }
  }
}
