import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { redact } from '../common/redact';
import { NormalizedInboundMessage } from '../inbound/inbound.types';

export type ProviderEventType =
  | 'provider.account.connected'
  | 'provider.account.disconnected'
  | 'message.received'
  | 'message.sent'
  | 'message.failed'
  | 'conversation.updated';

export interface ProviderEvent {
  eventType: ProviderEventType;
  tenantId: string;
  accountId: string;
  occurredAt: string;
  data: Record<string, unknown>;
}

/** Pushes events to Sigcore.  Connector-only — does not own conversations/messages. */
@Injectable()
export class SigcoreIngestService {
  private readonly logger = new Logger(SigcoreIngestService.name);

  async forwardInbound(message: NormalizedInboundMessage): Promise<void> {
    const url = this.required('SIGCORE_API_URL');
    const key = this.required('SIGCORE_WEBHOOK_KEY');
    await axios.post(
      `${url}/webhooks/telegram/inbound`,
      {
        tenantId: message.tenantId,
        provider: 'telegram',
        accountId: message.accountId,
        message,
      },
      {
        headers: { 'x-webhook-key': key, 'content-type': 'application/json' },
        timeout: 30000,
      },
    );
  }

  async emitProviderEvent(event: ProviderEvent): Promise<void> {
    const url = this.required('SIGCORE_API_URL');
    const key = this.required('SIGCORE_WEBHOOK_KEY');
    try {
      await axios.post(
        `${url}/webhooks/telegram/provider-events`,
        event,
        {
          headers: { 'x-webhook-key': key, 'content-type': 'application/json' },
          timeout: 30000,
        },
      );
    } catch (e) {
      // provider events are best-effort — never fail outbound sends because of them.
      this.logger.warn(`provider event ${event.eventType} forward failed: ${this.errorMsg(e)}`);
    }
  }

  private required(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`${name}_not_configured`);
    return v;
  }

  private errorMsg(e: unknown): string {
    if (e instanceof Error) {
      return JSON.stringify(redact({ message: e.message }));
    }
    return 'unknown_error';
  }
}
