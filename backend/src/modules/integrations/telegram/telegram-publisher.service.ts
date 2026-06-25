import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  TelegramSubscriber,
  TelegramLinkStatus,
  TelegramSubscriberMode,
} from '../../../database/entities/telegram-subscriber.entity';
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
  // Account-mode fields are additive — bot-mode callers ignore them.
  mode?: TelegramSubscriberMode;
  linkStatus?: TelegramLinkStatus | null;
  tgUserId?: string | null;
  tgUsername?: string | null;
}

export interface PublishApiResult {
  placementId: string;
  status: TelegramPlacementStatus;
  scheduledAt?: string;
}

/**
 * Account-mode response envelope — matches HF contract from local commit
 * `8fa96e5`. Returned by /account/start, /code, /password, /resend-code,
 * and the /subscribe?mode=account branch.
 */
export interface AccountSubscriptionEnvelope {
  subscription: {
    status: 'provisioning' | 'ready' | 'retired';
    mode: 'account';
    linkStatus: TelegramLinkStatus | null;
    tgUserId: string | null;
    tgUsername: string | null;
    lastSyncedAt: string;
  };
  nextStep?: 'code' | 'password' | 'linked' | 'start';
  message?: string;
  ok?: boolean;
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
    mode: TelegramSubscriberMode = 'bot',
  ): Promise<SubscribeResult | AccountSubscriptionEnvelope> {
    if (mode === 'account') {
      return this.subscribeAccountMode(workspaceId, tenantId);
    }

    // One active subscriber per workspace (partial unique idx enforces this).
    const existing = await this.subscriberRepo.findOne({
      where: { workspaceId },
      order: { createdAt: 'DESC' },
    });

    if (existing && existing.status !== 'retired') {
      // Existing row in account mode — bot subscribe call would silently
      // overwrite the link. Caller must explicitly DELETE /account first
      // OR call with mode='bot' to know they're switching back.
      // (Bot is the default and this code path; HF won't hit this unless
      // they re-call /subscribe after explicitly choosing bot.) Allow it
      // but log so we have an audit trail.
      if (existing.mode === 'account') {
        this.logger.warn(
          `subscribe(bot) overwriting existing account-mode row for workspace=${workspaceId}`,
        );
      }
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
      // Treat undefined/null mode as 'bot' — legacy rows that pre-date the
      // 1767000000000 migration won't have mode set. DB default handles
      // new rows but mocks/tests may not.
      if (!existing.mode || existing.mode === 'bot') {
        return {
          botUsername: existing.botUsername,
          status: existing.status,
          inviteHint: existing.inviteHint,
        };
      }
      // Existing account row — fall through to provision a bot row.
      // (Flips the existing row's mode to bot below.)
    }

    // Call µsvc FIRST. Only persist after a 2xx so a TelePorter rejection
    // doesn't leave a phantom `provisioning` row that blocks every retry
    // via the early-return branch above (round-1 + round-2 incidents,
    // 2026-06-24). If the call throws, propagate — caller gets the wrapped
    // teleporter_request_failed and the DB stays clean.
    const info = await this.client.provisionSubscriber(workspaceId, displayName);

    if (existing && existing.status !== 'retired') {
      // Flip existing row from account → bot in place (one-row-per-workspace
      // invariant from migration 1767000000000).
      await this.subscriberRepo.update(existing.id, {
        mode: 'bot' as const,
        teleporterSubscriberId: info.subscriberId,
        botUsername: info.botUsername,
        inviteHint: info.inviteHint,
        status: info.status === 'ready' ? 'ready' : 'provisioning',
        // Null out the link fields — account state is gone.
        tgUserId: undefined,
        tgUsername: undefined,
        linkAccountId: undefined,
        linkStatus: undefined,
        ...(info.status === 'ready' ? { provisionedAt: new Date() } : {}),
      });
    } else {
      const row = this.subscriberRepo.create({
        workspaceId,
        tenantId: tenantId ?? undefined,
        mode: 'bot' as const,
        teleporterSubscriberId: info.subscriberId,
        botUsername: info.botUsername,
        inviteHint: info.inviteHint,
        status: info.status === 'ready' ? 'ready' : ('provisioning' as const),
        ...(info.status === 'ready' ? { provisionedAt: new Date() } : {}),
      });
      await this.subscriberRepo.save(row);
    }

    return { botUsername: info.botUsername, status: info.status, inviteHint: info.inviteHint };
  }

  private async subscribeAccountMode(
    workspaceId: string,
    tenantId: string | undefined,
  ): Promise<AccountSubscriptionEnvelope> {
    const existing = await this.subscriberRepo.findOne({
      where: { workspaceId },
      order: { createdAt: 'DESC' },
    });

    if (existing && existing.status !== 'retired' && existing.mode === 'account') {
      return this.buildAccountEnvelope(existing, 'start');
    }

    if (existing && existing.status !== 'retired') {
      // Flip bot → account in place. Per brief: "the mode flips between bot
      // and account in place rather than requiring two rows".
      await this.subscriberRepo.update(existing.id, {
        mode: 'account' as const,
        status: 'ready' as const,
        // Clear bot-specific fields so we never accidentally call bot
        // endpoints with stale state.
        teleporterSubscriberId: undefined,
        botUsername: undefined,
        inviteHint: undefined,
        // Account fields stay null until /account/start lands a TelePorter 2xx.
        linkStatus: undefined,
        linkAccountId: undefined,
        tgUserId: undefined,
        tgUsername: undefined,
      });
      const reloaded = await this.subscriberRepo.findOne({ where: { id: existing.id } });
      return this.buildAccountEnvelope(reloaded!, 'start');
    }

    const row = this.subscriberRepo.create({
      workspaceId,
      tenantId: tenantId ?? undefined,
      mode: 'account' as const,
      status: 'ready' as const,
    });
    await this.subscriberRepo.save(row);
    return this.buildAccountEnvelope(row, 'start');
  }

  // ===== Account-mode operations =====

  async startAccountLink(
    workspaceId: string,
    tenantId: string | undefined,
    input: { phoneNumber: string; password?: string; riskAcknowledged: boolean },
  ): Promise<AccountSubscriptionEnvelope> {
    if (input.riskAcknowledged !== true) {
      throw new ConflictException({
        error: 'RISK_NOT_ACKNOWLEDGED',
        message: 'riskAcknowledged must be true before starting the link',
      });
    }

    // Ensure a row exists in account mode — auto-promote a missing or
    // bot-mode row so HF doesn't have to remember the /subscribe?mode=account
    // step. Same as subscribeAccountMode() shape.
    let row = await this.ensureAccountModeRow(workspaceId, tenantId);

    // µsvc call first — round-2 transactional pattern. On TelePorter
    // rejection we propagate without mutating the row's link state.
    const result = await this.client.startAccountLink({
      workspaceId,
      phoneNumber: input.phoneNumber,
      password: input.password,
      riskAcknowledged: input.riskAcknowledged,
    });

    await this.subscriberRepo.update(row.id, {
      linkAccountId: result.accountId,
      linkStatus: result.status,
    });
    row = (await this.subscriberRepo.findOne({ where: { id: row.id } })) ?? row;
    return this.buildAccountEnvelope(row, this.nextStepFor(result.status));
  }

  async submitAccountCode(
    workspaceId: string,
    code: string,
  ): Promise<AccountSubscriptionEnvelope> {
    const row = await this.requireAccountRow(workspaceId);
    const result = await this.client.submitAccountCode(workspaceId, code);
    await this.subscriberRepo.update(row.id, {
      linkAccountId: result.accountId,
      linkStatus: result.status,
      tgUserId: result.tgUserId ?? row.tgUserId,
      tgUsername: result.tgUsername ?? row.tgUsername,
    });
    const reloaded = (await this.subscriberRepo.findOne({ where: { id: row.id } })) ?? row;
    return this.buildAccountEnvelope(reloaded, this.nextStepFor(result.status));
  }

  async submitAccountPassword(
    workspaceId: string,
    password: string,
  ): Promise<AccountSubscriptionEnvelope> {
    const row = await this.requireAccountRow(workspaceId);
    const result = await this.client.submitAccountPassword(workspaceId, password);
    await this.subscriberRepo.update(row.id, {
      linkAccountId: result.accountId,
      linkStatus: result.status,
      tgUserId: result.tgUserId ?? row.tgUserId,
      tgUsername: result.tgUsername ?? row.tgUsername,
    });
    const reloaded = (await this.subscriberRepo.findOne({ where: { id: row.id } })) ?? row;
    return this.buildAccountEnvelope(reloaded, this.nextStepFor(result.status));
  }

  async resendAccountCode(workspaceId: string): Promise<AccountSubscriptionEnvelope> {
    const row = await this.requireAccountRow(workspaceId);
    await this.client.resendAccountCode(workspaceId);
    await this.subscriberRepo.update(row.id, { linkStatus: 'code_requested' });
    const reloaded = (await this.subscriberRepo.findOne({ where: { id: row.id } })) ?? row;
    return { ...this.buildAccountEnvelope(reloaded, 'code'), ok: true };
  }

  async deleteAccount(workspaceId: string): Promise<{ ok: true }> {
    const row = await this.subscriberRepo.findOne({ where: { workspaceId } });
    if (!row) return { ok: true };
    // Best-effort upstream call; even on failure we clear the local link
    // state so HF can recover. (If TelePorter's session is already gone,
    // the call may return 404 — that's fine, we want the same end state.)
    try {
      await this.client.deleteAccount(workspaceId);
    } catch (e: any) {
      this.logger.warn(`deleteAccount upstream failed (continuing): ${e.message}`);
    }
    await this.subscriberRepo.update(row.id, {
      status: 'retired' as const,
      retiredAt: new Date(),
      linkStatus: 'revoked' as const,
    });
    return { ok: true };
  }

  // ===== Helpers =====

  private async ensureAccountModeRow(
    workspaceId: string,
    tenantId: string | undefined,
  ): Promise<TelegramSubscriber> {
    const existing = await this.subscriberRepo.findOne({
      where: { workspaceId },
      order: { createdAt: 'DESC' },
    });
    if (existing && existing.status !== 'retired' && existing.mode === 'account') {
      return existing;
    }
    if (existing && existing.status !== 'retired') {
      await this.subscriberRepo.update(existing.id, {
        mode: 'account' as const,
        status: 'ready' as const,
        teleporterSubscriberId: undefined,
        botUsername: undefined,
        inviteHint: undefined,
        linkStatus: undefined,
        linkAccountId: undefined,
        tgUserId: undefined,
        tgUsername: undefined,
      });
      return (await this.subscriberRepo.findOne({ where: { id: existing.id } }))!;
    }
    const row = this.subscriberRepo.create({
      workspaceId,
      tenantId: tenantId ?? undefined,
      mode: 'account' as const,
      status: 'ready' as const,
    });
    await this.subscriberRepo.save(row);
    return row;
  }

  private async requireAccountRow(workspaceId: string): Promise<TelegramSubscriber> {
    const row = await this.subscriberRepo.findOne({
      where: { workspaceId },
      order: { createdAt: 'DESC' },
    });
    if (!row || row.status === 'retired' || row.mode !== 'account') {
      throw new ConflictException({
        error: 'ACCOUNT_MODE_NOT_INITIALIZED',
        message:
          'Call POST /api/integrations/telegram/subscribe?mode=account first to switch this workspace to account mode.',
      });
    }
    return row;
  }

  private buildAccountEnvelope(
    row: TelegramSubscriber,
    nextStep?: 'code' | 'password' | 'linked' | 'start',
  ): AccountSubscriptionEnvelope {
    return {
      subscription: {
        status: row.status,
        mode: 'account',
        linkStatus: (row.linkStatus as TelegramLinkStatus | undefined) ?? null,
        tgUserId: row.tgUserId ?? null,
        tgUsername: row.tgUsername ?? null,
        lastSyncedAt: (row.updatedAt ?? row.createdAt).toISOString(),
      },
      ...(nextStep ? { nextStep } : {}),
    };
  }

  private nextStepFor(
    status: TelegramLinkStatus | 'code_requested' | 'password_required',
  ): 'code' | 'password' | 'linked' | undefined {
    if (status === 'code_requested') return 'code';
    if (status === 'password_required') return 'password';
    if (status === 'linked') return 'linked';
    return undefined;
  }

  async getStatus(workspaceId: string): Promise<{
    botUsername?: string;
    status: 'provisioning' | 'ready' | 'retired' | 'not_initialized';
    inviteHint?: string;
    mode?: TelegramSubscriberMode;
    linkStatus?: TelegramLinkStatus | null;
    tgUserId?: string | null;
    tgUsername?: string | null;
    lastSyncedAt?: string;
  }> {
    const row = await this.subscriberRepo.findOne({
      where: { workspaceId },
      order: { createdAt: 'DESC' },
    });
    if (!row) return { status: 'not_initialized' };
    return {
      botUsername: row.botUsername,
      status: row.status,
      inviteHint: row.inviteHint,
      mode: row.mode,
      linkStatus: (row.linkStatus as TelegramLinkStatus | undefined) ?? null,
      tgUserId: row.tgUserId ?? null,
      tgUsername: row.tgUsername ?? null,
      lastSyncedAt: (row.updatedAt ?? row.createdAt).toISOString(),
    };
  }

  async verifyChat(
    workspaceId: string,
    chatRef: string,
    probe?: boolean,
  ): Promise<Record<string, unknown>> {
    // Drive asAccount from the local subscription's mode — HF doesn't
    // need to know which mode a workspace is in to call /verify-chat.
    const row = await this.subscriberRepo.findOne({
      where: { workspaceId },
      order: { createdAt: 'DESC' },
    });
    const asAccount =
      row?.mode === 'account' &&
      row?.status !== 'retired' &&
      row?.linkStatus === 'linked';
    return this.client.verifyChat({ workspaceId, chatRef, probe, asAccount });
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

    // Drive asAccount from the local subscription's mode — HF doesn't
    // need to know which mode a workspace is in to call /publish.
    const sub = await this.subscriberRepo.findOne({
      where: { workspaceId },
      order: { createdAt: 'DESC' },
    });
    const asAccount =
      sub?.mode === 'account' && sub?.status !== 'retired' && sub?.linkStatus === 'linked';
    const accountId = asAccount ? (sub?.linkAccountId ?? undefined) : undefined;

    try {
      const result = await this.client.publish({
        workspaceId,
        chatRef: dto.chatRef,
        text: dto.text,
        parseMode: dto.parseMode ?? null,
        imageUrl: dto.imageUrl,
        scheduledAt: dto.scheduledAt,
        idempotencyKey: dto.externalRef,
        asAccount,
        accountId,
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
   * Branches on eventType:
   *   placement.sent / placement.failed — updates the matching placement row
   *   account.linked / account.revoked — updates the matching subscriber row
   * Then fans out the corresponding outbound webhook event to subscribers.
   */
  async handleProviderEvent(payload: {
    workspaceId: string;
    eventType:
      | 'placement.sent'
      | 'placement.failed'
      | 'account.linked'
      | 'account.revoked';
    timestamp: string;
    data: {
      messageId?: string;
      providerMessageId?: string;
      errorCode?: string;
      errorMessage?: string;
      externalRef?: string;
      // Account event fields:
      accountId?: string;
      tgUserId?: string;
      tgUsername?: string;
      reason?: string;
      [k: string]: unknown;
    };
  }): Promise<void> {
    if (payload.eventType === 'account.linked' || payload.eventType === 'account.revoked') {
      return this.handleAccountEvent(payload as any);
    }

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

  private async handleAccountEvent(payload: {
    workspaceId: string;
    eventType: 'account.linked' | 'account.revoked';
    timestamp: string;
    data: {
      accountId?: string;
      tgUserId?: string;
      tgUsername?: string;
      reason?: string;
      [k: string]: unknown;
    };
  }): Promise<void> {
    const { workspaceId, eventType, data } = payload;
    const sub = await this.subscriberRepo.findOne({
      where: { workspaceId },
      order: { createdAt: 'DESC' },
    });
    if (!sub) {
      this.logger.warn(
        `Account event for unknown subscriber: workspace=${workspaceId} event=${eventType}`,
      );
      return;
    }

    if (eventType === 'account.linked') {
      await this.subscriberRepo.update(sub.id, {
        mode: 'account' as const,
        linkStatus: 'linked' as const,
        linkAccountId: data.accountId ?? sub.linkAccountId,
        tgUserId: data.tgUserId ?? sub.tgUserId,
        tgUsername: data.tgUsername ?? sub.tgUsername,
        // Clear bot-side fields — the subscription is unambiguously account
        // now (defensive in case the row carried stale bot state from a
        // prior subscribe call).
        teleporterSubscriberId: undefined,
        botUsername: undefined,
        inviteHint: undefined,
      });

      await this.outbound.emitEvent(
        workspaceId,
        WebhookEventType.TELEGRAM_ACCOUNT_LINKED,
        {
          subscriberWorkspaceId: workspaceId,
          tgUsername: data.tgUsername ?? null,
          tgUserId: data.tgUserId ?? null,
          occurredAt: payload.timestamp,
        },
        { tenantId: sub.tenantId || undefined },
      );
    } else {
      // account.revoked
      await this.subscriberRepo.update(sub.id, {
        linkStatus: 'revoked' as const,
      });
      await this.outbound.emitEvent(
        workspaceId,
        WebhookEventType.TELEGRAM_ACCOUNT_REVOKED,
        {
          subscriberWorkspaceId: workspaceId,
          reason: data.reason ?? 'UNKNOWN',
          occurredAt: payload.timestamp,
        },
        { tenantId: sub.tenantId || undefined },
      );
    }
  }
}
