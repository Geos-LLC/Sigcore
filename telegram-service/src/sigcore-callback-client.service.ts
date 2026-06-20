import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';

export interface SigcoreTelegramEvent {
  workspaceId: string;
  eventType: 'placement.sent' | 'placement.failed';
  data: Record<string, unknown>;
  timestamp: string;
}

@Injectable()
export class SigcoreCallbackClient {
  private readonly logger = new Logger(SigcoreCallbackClient.name);
  private readonly http: AxiosInstance;

  constructor() {
    const baseURL = process.env.SIGCORE_API_URL || 'http://localhost:3001';
    this.http = axios.create({ baseURL, timeout: 10_000 });
  }

  async forwardEvent(event: SigcoreTelegramEvent): Promise<void> {
    const webhookKey = process.env.SIGCORE_WEBHOOK_KEY;
    if (!webhookKey) {
      this.logger.error('SIGCORE_WEBHOOK_KEY not set — cannot forward event to main Sigcore');
      return;
    }
    try {
      await this.http.post('/internal/telegram/event', event, {
        headers: { 'Content-Type': 'application/json', 'x-webhook-key': webhookKey },
      });
    } catch (e: any) {
      this.logger.error(`Forward to Sigcore failed: ${e.message}`);
      throw e;
    }
  }
}
