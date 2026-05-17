import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { NormalizedInboundMessage } from './types';
import { redact } from './redact';

/**
 * Forwards normalized events to Sigcore core. Mirrors the WhatsApp connector
 * shape: POST /webhooks/telegram/inbound with `x-webhook-key` for service auth.
 */
@Injectable()
export class SigcoreIngestService {
  private readonly logger = new Logger(SigcoreIngestService.name);

  async forward(eventType: string, event: NormalizedInboundMessage | Record<string, unknown>): Promise<{
    ok: boolean;
    error?: string;
  }> {
    const url = process.env.SIGCORE_API_URL;
    const key = process.env.SIGCORE_WEBHOOK_KEY;
    if (!url || !key) {
      this.logger.debug('Sigcore ingestion not configured — skipping forward');
      return { ok: false, error: 'not_configured' };
    }

    try {
      await axios.post(
        `${url}/webhooks/telegram/inbound`,
        {
          eventType,
          provider: 'telegram',
          data: event,
          timestamp: new Date().toISOString(),
        },
        {
          headers: { 'x-webhook-key': key, 'Content-Type': 'application/json' },
          timeout: 30000,
        },
      );
      return { ok: true };
    } catch (err) {
      const summary = err instanceof Error ? err.message : 'unknown';
      this.logger.warn(`Failed to forward ${eventType} to Sigcore: ${summary}`, redact({}));
      return { ok: false, error: summary };
    }
  }
}
