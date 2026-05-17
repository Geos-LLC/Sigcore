import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { ProviderEvent, ProviderEventType } from './types';
import { redact } from './redact';

/**
 * Provider event bus. Emits coarse-grained lifecycle events to Sigcore that
 * downstream products (TelePorter, LeadBridge) subscribe to.
 *
 * Different channel from `SigcoreIngestService`:
 *   - SigcoreIngestService → /webhooks/telegram/inbound      (message payloads)
 *   - EventBusService      → /webhooks/telegram/provider-events (lifecycle)
 *
 * Failures here are best-effort and never block the inbound/outbound path —
 * the durable inbound store and the Sigcore ingest path are the authoritative
 * record. Provider events are signals.
 */
@Injectable()
export class EventBusService {
  private readonly logger = new Logger(EventBusService.name);

  async emit<T = Record<string, unknown>>(
    type: ProviderEventType,
    parts: { tenantId: string; accountId?: string; data: T },
  ): Promise<{ ok: boolean; error?: string }> {
    const event: ProviderEvent<T> = {
      type,
      provider: 'telegram',
      tenantId: parts.tenantId,
      accountId: parts.accountId,
      timestamp: new Date().toISOString(),
      data: parts.data,
    };

    const url = process.env.SIGCORE_API_URL;
    const key = process.env.SIGCORE_WEBHOOK_KEY;
    if (!url || !key) {
      // Local/dev mode — log the event so it's still observable.
      this.logger.debug(`[event-bus] ${type} (no SIGCORE_API_URL): ${JSON.stringify(redact(event))}`);
      return { ok: false, error: 'not_configured' };
    }

    try {
      await axios.post(
        `${url}/webhooks/telegram/provider-events`,
        event,
        {
          headers: { 'x-webhook-key': key, 'Content-Type': 'application/json' },
          timeout: 15000,
        },
      );
      return { ok: true };
    } catch (err) {
      const summary = err instanceof Error ? err.message : 'unknown';
      this.logger.warn(`[event-bus] ${type} failed: ${summary}`);
      return { ok: false, error: summary };
    }
  }
}
