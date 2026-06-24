import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TelegramSubscriber } from '../../../database/entities/telegram-subscriber.entity';
import {
  TelegramPlacement,
  TelegramPlacementStatus,
} from '../../../database/entities/telegram-placement.entity';
import { WebhookEventType } from '../../../database/entities/webhook-subscription.entity';
import { OutboundWebhooksService } from '../../webhooks/outbound-webhooks.service';
import { TelegramServiceClient } from './telegram-service.client';
import { PublishPlacementDto } from './dto/publish-placement.dto';

export interface SubscribeResult {
  botUsername?: string;
  status: 'provisioning' | 'ready' | 'retired';
  inviteHint?: string;
}

export interface PublishApiResult {
  placementId: string;
  status: TelegramPlacementStatus;
  scheduledAt?: string;
}

@Injectable()
export class TelegramPublisherService {
  private readonly logger = new Logger(TelegramPublisherService.name);

  constructor(
    @InjectRepository(TelegramSubscriber)
    private readonly subscriberRepo: Repository<TelegramSubscriber>,
    @InjectRepository(TelegramPlacement)
    private readonly placementRepo: Repository<TelegramPlacement>,
    private readonly client: TelegramServiceClient,
    private readonly outbound: OutboundWebhooksService,
  ) {}

  async subscribe(
    workspaceId: string,
    tenantId: string | undefined,
    displayName: string | undefined,
  ): Promise<SubscribeResult> {
    // One active subscriber per workspace (partial unique idx enforces this).
    const existing = await this.subscriberRepo.findOne({
      where: { workspaceId },
      order: { createdAt: 'DESC' },
    });

    if (existing && existing.status !== 'retired') {
      // If still provisioning, attempt to refresh from µsvc.
      if (existing.status === 'provisioning' && existing.teleporterSubscriberId) {
        try {
          const info = await this.client.getSubscriber(workspaceId);
          if (info?.status === 'ready') {
            await this.subscriberRepo.update(existing.id, {
              status: 'ready',
              botUsername: info.botUsername,
              inviteHint: info.inviteHint,
              provisionedAt: existing.provisionedAt || new Date(),
            });
            return { botUsername: info.botUsername, status: 'ready', inviteHint: info.inviteHint };
          }
        } catch (e: any) {
          this.logger.warn(`Refresh existing provisioning row failed: ${e.message}`);
        }
      }
      return {
        botUsername: existing.botUsername,
        status: existing.status,
        inviteHint: existing.inviteHint,
      };
    }

    // Call µsvc FIRST. Only persist after a 2xx so a TelePorter rejection
    // doesn't leave a phantom `provisioning` row that blocks every retry
    // via the early-return branch above (round-1 + round-2 incidents,
    // 2026-06-24). If the call throws, propagate — caller gets the wrapped
    // teleporter_request_failed and the DB stays clean.
    const info = await this.client.provisionSubscriber(workspaceId, displayName);

    const row = this.subscriberRepo.create({
      workspaceId,
      tenantId: tenantId ?? undefined,
      teleporterSubscriberId: info.subscriberId,
      botUsername: info.botUsername,
      inviteHint: info.inviteHint,
      status: info.status === 'ready' ? 'ready' : ('provisioning' as const),
      ...(info.status === 'ready' ? { provisionedAt: new Date() } : {}),
    });
    await this.subscriberRepo.save(row);

    return { botUsername: info.botUsername, status: info.status, inviteHint: info.inviteHint };
  }

  async getStatus(workspaceId: string): Promise<{
    botUsername?: string;
    status: 'provisioning' | 'ready' | 'retired' | 'not_initialized';
    inviteHint?: string;
  }> {
    const row = await this.subscriberRepo.findOne({
      where: { workspaceId },
      order: { createdAt: 'DESC' },
    });
    if (!row) return { status: 'not_initialized' };
    return { botUsername: row.botUsername, status: row.status, inviteHint: row.inviteHint };
  }

  async verifyChat(
    workspaceId: string,
    chatRef: string,
    probe?: boolean,
  ): Promise<Record<string, unknown>> {
    return this.client.verifyChat({ workspaceId, chatRef, probe });
  }

  async publish(
    workspaceId: string,
    tenantId: string | undefined,
    dto: PublishPlacementDto,
  ): Promise<PublishApiResult> {
    // Idempotency check FIRST — never even hit the microservice if we've
    // already accepted this externalRef.
    const existing = await this.placementRepo.findOne({
      where: { workspaceId, externalRef: dto.externalRef },
    });
    if (existing) {
      this.logger.log(
        `publish idempotent hit for workspace=${workspaceId} externalRef=${dto.externalRef} → placement=${existing.id}`,
      );
      return {
        placementId: existing.id,
        status: existing.status,
        scheduledAt: existing.scheduledAt?.toISOString(),
      };
    }

    const row = this.placementRepo.create({
      workspaceId,
      tenantId: tenantId ?? undefined,
      chatRef: dto.chatRef,
      text: dto.text,
      imageUrl: dto.imageUrl,
      parseMode: dto.parseMode ?? undefined,
      scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : undefined,
      externalRef: dto.externalRef,
      status: 'queued' as const,
    });
    await this.placementRepo.save(row);

    try {
      const result = await this.client.publish({
        workspaceId,
        chatRef: dto.chatRef,
        text: dto.text,
        parseMode: dto.parseMode ?? null,
        imageUrl: dto.imageUrl,
        scheduledAt: dto.scheduledAt,
        idempotencyKey: dto.externalRef,
      });
      const newStatus = (result.status as TelegramPlacementStatus) || (dto.scheduledAt ? 'scheduled' : 'queued');
      await this.placementRepo.update(row.id, {
        teleporterMessageId: result.messageId,
        status: newStatus,
      });
      return {
        placementId: row.id,
        status: newStatus,
        scheduledAt: result.scheduledAt,
      };
    } catch (e: any) {
      // Mark failed so callers can see why. Don't delete the row — the
      // externalRef is now bound to this attempt (idempotent retries should
      // pull the same placement).
      await this.placementRepo.update(row.id, {
        status: 'failed',
        errorCode: 'TELEPORTER_REQUEST_FAILED',
        errorMessage: e?.message?.slice(0, 1000),
      });
      throw e;
    }
  }

  async cancel(placementId: string, workspaceId: string): Promise<PublishApiResult> {
    const row = await this.placementRepo.findOne({ where: { id: placementId, workspaceId } });
    if (!row) throw new NotFoundException('Placement not found');
    if (row.status === 'sent') {
      throw new ConflictException('Cannot cancel — placement already sent');
    }
    if (row.status === 'cancelled') {
      return { placementId: row.id, status: 'cancelled', scheduledAt: row.scheduledAt?.toISOString() };
    }
    if (row.status === 'failed') {
      throw new ConflictException('Cannot cancel — placement already failed');
    }

    if (row.teleporterMessageId) {
      try {
        await this.client.cancelMessage(row.teleporterMessageId);
      } catch (e: any) {
        this.logger.warn(`Cancel forward to TelePorter failed (continuing): ${e.message}`);
      }
    }

    await this.placementRepo.update(row.id, { status: 'cancelled' });
    return { placementId: row.id, status: 'cancelled', scheduledAt: row.scheduledAt?.toISOString() };
  }

  async getPlacement(placementId: string, workspaceId: string): Promise<TelegramPlacement> {
    const row = await this.placementRepo.findOne({ where: { id: placementId, workspaceId } });
    if (!row) throw new NotFoundException('Placement not found');
    return row;
  }

  /**
   * Called by the µsvc → main callback at POST /internal/telegram/event.
   * Looks up the placement (preferring teleporter_message_id) and
   * applies the status update + emits the public webhook event.
   */
  async handleProviderEvent(payload: {
    workspaceId: string;
    eventType: 'placement.sent' | 'placement.failed';
    timestamp: string;
    data: {
      messageId?: string;
      providerMessageId?: string;
      errorCode?: string;
      errorMessage?: string;
      externalRef?: string;
      [k: string]: unknown;
    };
  }): Promise<void> {
    const { workspaceId, eventType, data } = payload;
    let row: TelegramPlacement | null = null;

    if (data.messageId) {
      row = await this.placementRepo.findOne({
        where: { workspaceId, teleporterMessageId: data.messageId },
      });
    }
    if (!row && data.externalRef) {
      row = await this.placementRepo.findOne({
        where: { workspaceId, externalRef: data.externalRef as string },
      });
    }
    if (!row) {
      this.logger.warn(
        `Provider event for unknown placement: workspace=${workspaceId} messageId=${data.messageId} externalRef=${data.externalRef}`,
      );
      return;
    }

    if (eventType === 'placement.sent') {
      await this.placementRepo.update(row.id, {
        status: 'sent',
        providerMessageId: (data.providerMessageId as string) || row.providerMessageId,
        sentAt: new Date(payload.timestamp || Date.now()),
        errorCode: undefined,
        errorMessage: undefined,
      });
    } else {
      await this.placementRepo.update(row.id, {
        status: 'failed',
        errorCode: (data.errorCode as string) || 'UNKNOWN',
        errorMessage: (data.errorMessage as string) || undefined,
      });
    }

    const webhookEvent =
      eventType === 'placement.sent'
        ? WebhookEventType.TELEGRAM_PLACEMENT_SENT
        : WebhookEventType.TELEGRAM_PLACEMENT_FAILED;

    await this.outbound.emitEvent(
      workspaceId,
      webhookEvent,
      {
        placementId: row.id,
        chatRef: row.chatRef,
        externalRef: row.externalRef,
        teleporterMessageId: row.teleporterMessageId,
        providerMessageId: (data.providerMessageId as string) || row.providerMessageId,
        status: eventType === 'placement.sent' ? 'sent' : 'failed',
        errorCode: (data.errorCode as string) || undefined,
        errorMessage: (data.errorMessage as string) || undefined,
        occurredAt: payload.timestamp,
      },
      { tenantId: row.tenantId || undefined },
    );
  }
}
