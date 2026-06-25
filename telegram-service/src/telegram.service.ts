import { Injectable, Logger } from '@nestjs/common';
import {
  TeleporterClient,
  PublishMessageDto,
  SubscriberInfo,
  PublishMessageResult,
  StartAccountLinkDto,
  AccountStartResult,
  AccountStepResult,
  AccountInfo,
} from './teleporter-client.service';
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
  asAccount?: boolean;
}

export interface PublishRequest {
  workspaceId: string;
  chatRef: string;
  text?: string;
  parseMode?: 'Markdown' | 'HTML' | null;
  imageUrl?: string;
  scheduledAt?: string;
  idempotencyKey: string;
  asAccount?: boolean;
  accountId?: string;
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
    // Account-mode verify can yield different results than bot-mode (the
    // recruiter user may be a member of channels the bot isn't admin-of).
    // Don't share cache entries across modes — namespace the key.
    const cacheKey = req.asAccount ? `account:${req.chatRef}` : req.chatRef;

    // Cache read: skip when probe (caller explicitly wants a fresh probe).
    if (!isProbe) {
      const cached = this.cache.get(req.workspaceId, cacheKey);
      if (cached) {
        this.logger.debug(`verify cache HIT for ${req.workspaceId}:${cacheKey}`);
        return cached;
      }
    }

    const verdict = await this.teleporter.verifyChat({
      subscriberWorkspaceId: req.workspaceId,
      chatRef: req.chatRef,
      probe: req.probe,
      asAccount: req.asAccount,
    });

    const enriched = this.injectPayToPostWarning(verdict);

    // Cache writes only when verdict is non-probe — probes are expensive
    // and may reflect transient state we don't want to bake into the cache.
    if (!isProbe) this.cache.set(req.workspaceId, cacheKey, enriched);

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
      asAccount: req.asAccount,
      accountId: req.accountId,
    };

    return this.teleporter.publishMessage(dto);
  }

  async cancel(messageId: string): Promise<PublishMessageResult> {
    return this.teleporter.cancelMessage(messageId);
  }

  // ===== Account-mode pass-through =====

  async startAccountLink(input: {
    workspaceId: string;
    phoneNumber: string;
    password?: string;
    riskAcknowledged: boolean;
  }): Promise<AccountStartResult> {
    const dto: StartAccountLinkDto = {
      subscriberWorkspaceId: input.workspaceId,
      phoneNumber: input.phoneNumber,
      password: input.password,
      riskAcknowledged: input.riskAcknowledged,
    };
    return this.teleporter.startAccountLink(dto);
  }

  async submitAccountCode(workspaceId: string, code: string): Promise<AccountStepResult> {
    return this.teleporter.submitAccountCode(workspaceId, code);
  }

  async submitAccountPassword(
    workspaceId: string,
    password: string,
  ): Promise<AccountStepResult> {
    return this.teleporter.submitAccountPassword(workspaceId, password);
  }

  async resendAccountCode(workspaceId: string): Promise<{ status: 'code_requested' }> {
    return this.teleporter.resendAccountCode(workspaceId);
  }

  async getAccount(workspaceId: string): Promise<AccountInfo> {
    return this.teleporter.getAccount(workspaceId);
  }

  async deleteAccount(workspaceId: string): Promise<{ status: 'unlinked' }> {
    return this.teleporter.deleteAccount(workspaceId);
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
