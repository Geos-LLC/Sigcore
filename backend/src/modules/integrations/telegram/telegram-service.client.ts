import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface SubscriberInfo {
  subscriberId: string;
  botUsername: string;
  status: 'provisioning' | 'ready' | 'retired';
  inviteHint?: string;
}

export interface PublishResult {
  messageId: string;
  status: 'queued' | 'scheduled' | 'sent' | 'failed' | 'cancelled';
  scheduledAt?: string;
}

export type AccountLinkStatus =
  | 'code_requested'
  | 'password_required'
  | 'linked'
  | 'revoked';

export interface AccountStartResult {
  accountId: string;
  status: 'code_requested' | 'password_required';
  codeLength?: number;
}

export interface AccountStepResult {
  accountId: string;
  status: AccountLinkStatus;
  tgUserId?: string;
  tgUsername?: string;
}

export interface AccountInfo {
  accountId: string;
  status: AccountLinkStatus;
  tgUsername?: string;
}

/**
 * Main-side HTTP client for the telegram-service microservice.
 * Mirrors WhatsAppWebProvider's fetch wrapper shape so anyone debugging
 * one service-to-service hop can read the other.
 */
@Injectable()
export class TelegramServiceClient {
  private readonly logger = new Logger(TelegramServiceClient.name);
  private readonly serviceUrl: string;
  private readonly apiKey: string;

  constructor(private readonly configService: ConfigService) {
    this.serviceUrl =
      this.configService.get<string>('TELEGRAM_SERVICE_URL') || 'http://localhost:3002';
    this.apiKey = this.configService.get<string>('TELEGRAM_SERVICE_API_KEY') || '';
    this.logger.log(`Telegram service URL: ${this.serviceUrl}`);
  }

  async provisionSubscriber(workspaceId: string, displayName?: string): Promise<SubscriberInfo> {
    return this.call('POST', '/subscribers', { workspaceId, displayName });
  }

  async getSubscriber(workspaceId: string): Promise<SubscriberInfo> {
    return this.call('GET', `/subscribers/${encodeURIComponent(workspaceId)}`);
  }

  async deleteSubscriber(workspaceId: string): Promise<void> {
    await this.call('DELETE', `/subscribers/${encodeURIComponent(workspaceId)}`);
  }

  async verifyChat(input: {
    workspaceId: string;
    chatRef: string;
    probe?: boolean;
    asAccount?: boolean;
  }): Promise<Record<string, unknown>> {
    return this.call('POST', '/verify-chat', input);
  }

  async publish(input: {
    workspaceId: string;
    chatRef: string;
    text?: string;
    parseMode?: 'Markdown' | 'HTML' | null;
    imageUrl?: string;
    scheduledAt?: string;
    idempotencyKey: string;
    asAccount?: boolean;
    accountId?: string;
  }): Promise<PublishResult> {
    return this.call('POST', '/publish', input);
  }

  async cancelMessage(teleporterMessageId: string): Promise<PublishResult> {
    return this.call('POST', `/messages/${encodeURIComponent(teleporterMessageId)}/cancel`);
  }

  // ===== Account-mode endpoints (pass-through wrappers) =====

  async startAccountLink(input: {
    workspaceId: string;
    phoneNumber: string;
    password?: string;
    riskAcknowledged: boolean;
  }): Promise<AccountStartResult> {
    return this.call('POST', '/accounts', input);
  }

  async submitAccountCode(workspaceId: string, code: string): Promise<AccountStepResult> {
    return this.call('POST', `/accounts/${encodeURIComponent(workspaceId)}/code`, { code });
  }

  async submitAccountPassword(
    workspaceId: string,
    password: string,
  ): Promise<AccountStepResult> {
    return this.call('POST', `/accounts/${encodeURIComponent(workspaceId)}/password`, {
      password,
    });
  }

  async resendAccountCode(workspaceId: string): Promise<{ status: 'code_requested' }> {
    return this.call('POST', `/accounts/${encodeURIComponent(workspaceId)}/resend-code`);
  }

  async getAccount(workspaceId: string): Promise<AccountInfo> {
    return this.call('GET', `/accounts/${encodeURIComponent(workspaceId)}`);
  }

  async deleteAccount(workspaceId: string): Promise<{ status: 'unlinked' }> {
    return this.call('DELETE', `/accounts/${encodeURIComponent(workspaceId)}`);
  }

  private async call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.serviceUrl}${path}`;
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Telegram service error: ${res.status} - ${text}`);
      }
      // 204/empty bodies on DELETE
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) return undefined as T;
      return (await res.json()) as T;
    } catch (e: any) {
      if (e?.message?.includes('fetch failed')) {
        this.logger.warn(`Telegram service unavailable at ${this.serviceUrl}`);
        throw new Error('Telegram service is not available.');
      }
      throw e;
    }
  }
}
