import { Injectable, Logger } from '@nestjs/common';
import { TeleporterClient, PublishMessageDto, SubscriberInfo, PublishMessageResult } from './teleporter-client.service';
import { VerifyCache } from './verify-cache.service';

/**
 * Per Brief A addendum: ready chats always carry this warning because
 * "pay to post" channel restrictions are not detectable via Telegram's
 * Bot API. HF renders a disclaimer based on it.
 */
const PAY_TO_POST_WARNING = 'PAY_TO_POST_NOT_DETECTABLE';

export interface VerifyChatRequest {
  workspaceId: string;
  chatRef: string;
  probe?: boolean;
}

export interface PublishRequest {
  workspaceId: string;
  chatRef: string;
  text?: string;
  parseMode?: 'Markdown' | 'HTML' | null;
  imageUrl?: string;
  scheduledAt?: string;
  idempotencyKey: string;
}

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);

  constructor(
    private readonly teleporter: TeleporterClient,
    private readonly cache: VerifyCache,
  ) {}

  async provisionSubscriber(workspaceId: string, displayName?: string): Promise<SubscriberInfo> {
    return this.teleporter.provisionSubscriber({ subscriberWorkspaceId: workspaceId, displayName });
  }

  async getSubscriber(workspaceId: string): Promise<SubscriberInfo> {
    return this.teleporter.getSubscriber(workspaceId);
  }

  async deleteSubscriber(workspaceId: string): Promise<void> {
    return this.teleporter.deleteSubscriber(workspaceId);
  }

  async verifyChat(req: VerifyChatRequest): Promise<Record<string, unknown>> {
    const isProbe = req.probe === true;

    // Cache read: skip when probe (caller explicitly wants a fresh probe).
    if (!isProbe) {
      const cached = this.cache.get(req.workspaceId, req.chatRef);
      if (cached) {
        this.logger.debug(`verify cache HIT for ${req.workspaceId}:${req.chatRef}`);
        return cached;
      }
    }

    const verdict = await this.teleporter.verifyChat({
      subscriberWorkspaceId: req.workspaceId,
      chatRef: req.chatRef,
      probe: req.probe,
    });

    const enriched = this.injectPayToPostWarning(verdict);

    // Cache writes only when verdict is non-probe — probes are expensive
    // and may reflect transient state we don't want to bake into the cache.
    if (!isProbe) this.cache.set(req.workspaceId, req.chatRef, enriched);

    return enriched;
  }

  async publish(req: PublishRequest): Promise<PublishMessageResult> {
    const callbackUrl =
      process.env.TELEPORTER_CALLBACK_URL ||
      `${(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '')}/webhooks/teleporter`;

    const dto: PublishMessageDto = {
      subscriberWorkspaceId: req.workspaceId,
      chatRef: req.chatRef,
      text: req.text,
      parseMode: req.parseMode ?? undefined,
      imageUrl: req.imageUrl,
      scheduledAt: req.scheduledAt,
      idempotencyKey: req.idempotencyKey,
      callbackUrl,
    };

    return this.teleporter.publishMessage(dto);
  }

  async cancel(messageId: string): Promise<PublishMessageResult> {
    return this.teleporter.cancelMessage(messageId);
  }

  /**
   * Add PAY_TO_POST_NOT_DETECTABLE to verdict.warnings when status is
   * 'ready'. Preserves whatever TelePorter already returned in warnings.
   */
  private injectPayToPostWarning(verdict: Record<string, unknown>): Record<string, unknown> {
    if (verdict?.status !== 'ready') return verdict;
    const existing = Array.isArray(verdict.warnings) ? (verdict.warnings as string[]) : [];
    if (existing.includes(PAY_TO_POST_WARNING)) return verdict;
    return { ...verdict, warnings: [...existing, PAY_TO_POST_WARNING] };
  }
}
