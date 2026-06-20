import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import axios, { AxiosInstance, AxiosError } from 'axios';

export interface ProvisionSubscriberDto {
  subscriberWorkspaceId: string;
  displayName?: string;
}

export interface SubscriberInfo {
  subscriberId: string;
  botUsername: string;
  status: 'provisioning' | 'ready' | 'retired';
  inviteHint?: string;
}

export interface VerifyChatDto {
  subscriberWorkspaceId: string;
  chatRef: string;
  probe?: boolean;
}

export interface PublishMessageDto {
  subscriberWorkspaceId: string;
  chatRef: string;
  text?: string;
  parseMode?: 'Markdown' | 'HTML' | null;
  imageUrl?: string;
  scheduledAt?: string;
  idempotencyKey: string;
  callbackUrl: string;
}

export interface PublishMessageResult {
  messageId: string;
  status: 'queued' | 'scheduled' | 'sent' | 'failed' | 'cancelled';
  scheduledAt?: string;
}

@Injectable()
export class TeleporterClient {
  private readonly logger = new Logger(TeleporterClient.name);
  private readonly http: AxiosInstance;

  constructor() {
    const baseURL = process.env.TELEPORTER_BASE_URL || 'http://localhost:4000';
    const key = process.env.TELEPORTER_SERVICE_KEY || '';
    this.http = axios.create({
      baseURL,
      timeout: 10_000,
      headers: { 'X-TelePorter-Service-Key': key, 'Content-Type': 'application/json' },
    });
  }

  async provisionSubscriber(dto: ProvisionSubscriberDto): Promise<SubscriberInfo> {
    return this.call('POST', '/subscribers', dto);
  }

  async getSubscriber(subscriberWorkspaceId: string): Promise<SubscriberInfo> {
    return this.call('GET', `/subscribers/${encodeURIComponent(subscriberWorkspaceId)}`);
  }

  async deleteSubscriber(subscriberWorkspaceId: string): Promise<void> {
    await this.call('DELETE', `/subscribers/${encodeURIComponent(subscriberWorkspaceId)}`);
  }

  async verifyChat(dto: VerifyChatDto): Promise<Record<string, unknown>> {
    return this.call('POST', '/chats/verify', dto);
  }

  async publishMessage(dto: PublishMessageDto): Promise<PublishMessageResult> {
    return this.call('POST', '/messages', dto);
  }

  async cancelMessage(messageId: string): Promise<PublishMessageResult> {
    return this.call('POST', `/messages/${encodeURIComponent(messageId)}/cancel`);
  }

  async getMessage(messageId: string): Promise<PublishMessageResult> {
    return this.call('GET', `/messages/${encodeURIComponent(messageId)}`);
  }

  private async call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    try {
      const res = await this.http.request<T>({ method, url: path, data: body });
      return res.data;
    } catch (e) {
      const err = e as AxiosError<any>;
      const status = err.response?.status ?? HttpStatus.BAD_GATEWAY;
      const msg = err.response?.data?.message || err.message || 'TelePorter request failed';
      this.logger.error(`TelePorter ${method} ${path} → ${status}: ${msg}`);
      throw new HttpException(
        { error: 'teleporter_request_failed', message: msg, upstreamStatus: status },
        status >= 400 && status < 600 ? status : HttpStatus.BAD_GATEWAY,
      );
    }
  }
}
