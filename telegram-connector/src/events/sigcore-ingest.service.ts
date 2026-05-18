import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import { redact } from '../common/redact';

/**
 * Forwards normalized payloads to Sigcore via the generic provider-ingest
 * endpoint. There is no Telegram-specific route — Sigcore dispatches by
 * the `provider` field in the body. This is the architectural fix called
 * out in the P0 follow-up: connectors target one generic endpoint, the
 * platform owns persistence.
 */
@Injectable()
export class SigcoreIngestService {
  private readonly logger = new Logger(SigcoreIngestService.name);
  private readonly http: AxiosInstance;

  constructor() {
    this.http = axios.create({ timeout: 30000 });
  }

  async forwardInbound(payload: {
    workspaceId: string;
    eventType: string;
    data: Record<string, unknown>;
  }): Promise<void> {
    const baseUrl = process.env.SIGCORE_API_URL;
    const webhookKey = process.env.SIGCORE_WEBHOOK_KEY;
    if (!baseUrl || !webhookKey) {
      this.logger.warn('SIGCORE_API_URL or SIGCORE_WEBHOOK_KEY missing — skipping forward');
      throw new Error('sigcore_ingest_not_configured');
    }

    const body = {
      provider: 'telegram',
      workspaceId: payload.workspaceId,
      eventType: payload.eventType,
      data: payload.data,
      timestamp: new Date().toISOString(),
    };

    try {
      await this.http.post(`${baseUrl}/webhooks/provider/inbound`, body, {
        headers: {
          'x-webhook-key': webhookKey,
          'Content-Type': 'application/json',
        },
      });
    } catch (e: any) {
      this.logger.warn(
        `Sigcore ingest failed: ${e?.response?.status || ''} ${e?.message || ''} body=${JSON.stringify(redact(body))}`,
      );
      throw e;
    }
  }
}
