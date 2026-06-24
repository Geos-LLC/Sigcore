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
      const data = err.response?.data;
      // Surface the full upstream response body — TelePorter's error shape
      // is not contract-locked, so grabbing only `data.message` loses the
      // actual reason on every other shape (round-2 incident 2026-06-24
      // hit exactly this: 400 with body in `error`/`details`/whatever).
      // Log the body verbatim and pick the most-informative single string
      // for the exception message.
      const dataStr =
        typeof data === 'string'
          ? data
          : data
            ? JSON.stringify(data).slice(0, 1000)
            : '';
      const msg =
        (typeof data === 'object' && data &&
          (data.message || data.error || data.detail || data.details)) ||
        dataStr ||
        err.message ||
        'TelePorter request failed';
      const bodyPreview = body ? JSON.stringify(body).slice(0, 400) : '<no body>';
      this.logger.error(
        `TelePorter ${method} ${path} → ${status} | reqBody=${bodyPreview} | respBody=${dataStr || '<empty>'}`,
      );
      throw new HttpException(
        {
          error: 'teleporter_request_failed',
          message: typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 500),
          upstreamStatus: status,
          upstreamBody: data ?? null,
        },
        status >= 400 && status < 600 ? status : HttpStatus.BAD_GATEWAY,
      );
    }
  }
}
