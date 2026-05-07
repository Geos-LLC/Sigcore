import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import * as crypto from 'crypto';
import {
  WebhookSubscription,
  WebhookEventType,
  WebhookSubscriptionStatus,
} from '../../database/entities/webhook-subscription.entity';
import { CommunicationMessage } from '../../database/entities/communication-message.entity';

export interface WebhookPayload {
  event: WebhookEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

@Injectable()
export class OutboundWebhooksService {
  private readonly logger = new Logger(OutboundWebhooksService.name);
  private readonly MAX_FAILURES = 10; // Pause subscription after this many consecutive failures
  private readonly WEBHOOK_TIMEOUT = 10000; // 10 seconds

  constructor(
    @InjectRepository(WebhookSubscription)
    private subscriptionRepo: Repository<WebhookSubscription>,
  ) {}

  /**
   * Emit an event with additive scope-based fan-out.
   *
   * Each subscription has at most one narrow scope. A sub fires when its
   * narrowest scope matches the event scope:
   *   - profile-scoped sub  → fires iff scope.profileId === sub.communicationProfileId
   *   - business-scoped sub → fires iff scope.businessId === sub.communicationBusinessId
   *   - tenant-scoped sub   → fires iff scope.tenantId === sub.tenantId
   *   - workspace-scoped sub (no narrower scope) → fires for every event in the workspace
   *
   * Multiple subs at different scopes can all fire for the same event (the
   * "additive" behavior locked in by decision #4 / #10).
   *
   * Issue #114 (cross-tenant fan-out) is preserved — tenant-scoped subs
   * only fire when their tenant_id matches the event's tenant_id.
   *
   * Backward compatibility: the 4th arg accepts either a string (legacy
   * tenantId-only) or a scope object.
   */
  async emitEvent(
    workspaceId: string,
    eventType: WebhookEventType,
    data: Record<string, unknown>,
    scopeArg?:
      | string
      | { tenantId?: string; businessId?: string; profileId?: string },
  ): Promise<void> {
    const scope: { tenantId?: string; businessId?: string; profileId?: string } =
      typeof scopeArg === 'string' ? { tenantId: scopeArg } : scopeArg ?? {};

    const subscriptions = await this.subscriptionRepo.find({
      where: [
        { workspaceId, status: WebhookSubscriptionStatus.ACTIVE },
        { workspaceId, status: WebhookSubscriptionStatus.PAUSED },
      ],
    });

    // Filter to only subscriptions that listen for this event.
    let relevantSubscriptions = subscriptions.filter((sub) =>
      sub.events.includes(eventType),
    );

    // Per-sub scope match (additive — narrowest scope wins per sub, but
    // multiple subs at different scopes can all match the same event).
    relevantSubscriptions = relevantSubscriptions.filter((sub) => {
      if (sub.communicationProfileId) {
        return (
          !!scope.profileId && scope.profileId === sub.communicationProfileId
        );
      }
      if (sub.communicationBusinessId) {
        return (
          !!scope.businessId && scope.businessId === sub.communicationBusinessId
        );
      }
      if (sub.tenantId) {
        return !!scope.tenantId && scope.tenantId === sub.tenantId;
      }
      // workspace-scoped sub: fires for every event in this workspace.
      return true;
    });

    if (relevantSubscriptions.length === 0) {
      this.logger.debug(
        `No matching subscriptions for event ${eventType} in workspace ${workspaceId} (scope=${JSON.stringify(
          scope,
        )})`,
      );
      return;
    }

    if (relevantSubscriptions.length > 1) {
      this.logger.log(
        `[emitEvent] ${relevantSubscriptions.length} subscriptions matched ` +
          `(event=${eventType} workspace=${workspaceId} scope=${JSON.stringify(scope)})`,
      );
    }

    const payload: WebhookPayload = {
      event: eventType,
      timestamp: new Date().toISOString(),
      data,
    };

    // Send to all subscriptions in parallel (fire and forget for performance)
    await Promise.allSettled(
      relevantSubscriptions.map((sub) => this.sendWebhook(sub, payload)),
    );
  }

  /**
   * Emit message event. The 5th arg accepts either a tenantId string
   * (legacy callers) or a `{ tenantId, businessId, profileId }` scope
   * object so callers wired through the routing resolver can fan out
   * additively across all matching scopes.
   */
  async emitMessageEvent(
    workspaceId: string,
    eventType: WebhookEventType,
    message: CommunicationMessage,
    additionalData?: Record<string, unknown>,
    scopeArg?:
      | string
      | { tenantId?: string; businessId?: string; profileId?: string },
  ): Promise<void> {
    const scope: { tenantId?: string; businessId?: string; profileId?: string } =
      typeof scopeArg === 'string' ? { tenantId: scopeArg } : scopeArg ?? {};

    const data = {
      messageId: message.id,
      conversationId: message.conversationId,
      direction: message.direction,
      channel: message.channel,
      body: message.body,
      fromNumber: message.fromNumber,
      toNumber: message.toNumber,
      status: message.status,
      providerMessageId: message.providerMessageId,
      createdAt: message.createdAt,
      // Include metadata (contains tenantId, leadId from LeadBridge)
      ...(message.metadata || {}),
      ...(additionalData || {}),
      // Surface the resolved scope on the wire so subscribers can route
      // by profile/business without needing a separate lookup.
      ...(scope.tenantId && { tenantId: scope.tenantId }),
      ...(scope.businessId && { communicationBusinessId: scope.businessId }),
      ...(scope.profileId && { communicationProfileId: scope.profileId }),
    };

    await this.emitEvent(workspaceId, eventType, data, scope);
  }

  /**
   * Send webhook to a subscription.
   *
   * Signature contract (aligned with the SF /lead-status verifier shape so
   * one HMAC implementation covers all SF inbound webhook routes):
   *   X-Callio-Timestamp : epoch seconds, integer-as-string
   *   X-Callio-Signature : hex(HMAC-SHA256(secret, `${ts}.${rawBody}`))
   *
   * `payload.timestamp` (the ISO field on the JSON body) is preserved for
   * subscribers that already parse it — the HEADER format changes only.
   * The body content is unchanged.
   */
  private async sendWebhook(
    subscription: WebhookSubscription,
    payload: WebhookPayload,
  ): Promise<void> {
    const payloadString = JSON.stringify(payload);

    try {
      // Epoch seconds for HMAC + replay-window check on the receiver side.
      const tsEpoch = String(Math.floor(Date.now() / 1000));

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Callio-Event': payload.event,
        'X-Callio-Timestamp': tsEpoch,
      };

      // Add signature if secret is configured
      if (subscription.secret) {
        const signature = this.signPayload(
          `${tsEpoch}.${payloadString}`,
          subscription.secret,
        );
        headers['X-Callio-Signature'] = signature;
      }

      this.logger.debug(`Sending webhook to ${subscription.webhookUrl} for event ${payload.event}`);

      await axios.post(subscription.webhookUrl, payload, {
        headers,
        timeout: this.WEBHOOK_TIMEOUT,
      });

      // Mark success — auto-resume if was paused
      const waspaused = subscription.status === WebhookSubscriptionStatus.PAUSED;
      await this.subscriptionRepo.update(subscription.id, {
        lastSuccessAt: new Date(),
        failureCount: 0,
        lastError: undefined,
        status: WebhookSubscriptionStatus.ACTIVE,
      } as any);

      if (waspaused) {
        this.logger.log(`Auto-resumed webhook subscription ${subscription.name} after successful delivery`);
      }
      this.logger.log(`Webhook delivered to ${subscription.name}: ${payload.event}`);
    } catch (error: any) {
      const errorMessage = error.message || 'Unknown error';
      this.logger.error(`Webhook delivery failed to ${subscription.webhookUrl}: ${errorMessage}`);

      // Update failure count
      const newFailureCount = subscription.failureCount + 1;
      const updateData = {
        lastFailureAt: new Date(),
        failureCount: newFailureCount,
        lastError: errorMessage,
      } as Partial<WebhookSubscription>;

      // Pause subscription if too many failures
      if (newFailureCount >= this.MAX_FAILURES) {
        updateData.status = WebhookSubscriptionStatus.PAUSED;
        this.logger.warn(`Paused webhook subscription ${subscription.name} after ${newFailureCount} failures`);
      }

      await this.subscriptionRepo.update(subscription.id, updateData as any);
    }
  }

  /**
   * Sign payload using HMAC-SHA256
   */
  private signPayload(payload: string, secret: string): string {
    return crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');
  }

  // ==================== Subscription Management ====================

  /**
   * Create a webhook subscription.
   * Upserts by (workspaceId, webhookUrl) — if a subscription for this URL already
   * exists in the workspace, it is updated in-place rather than creating a duplicate.
   */
  async createSubscription(
    workspaceId: string,
    data: {
      name: string;
      webhookUrl: string;
      secret?: string;
      events: WebhookEventType[];
      metadata?: Record<string, unknown>;
    },
    tenantId?: string,
  ): Promise<WebhookSubscription> {
    const existing = await this.subscriptionRepo.findOne({
      where: { workspaceId, webhookUrl: data.webhookUrl },
    });

    if (existing) {
      // Upsert: update the existing subscription instead of creating a duplicate
      await this.subscriptionRepo.update(existing.id, {
        name: data.name,
        secret: data.secret,
        events: data.events,
        metadata: data.metadata,
        ...(tenantId && { tenantId }),
        status: WebhookSubscriptionStatus.ACTIVE,
        failureCount: 0,
      } as any);
      this.logger.log(
        `Upserted existing webhook subscription: ${data.name} (${existing.id}) — no duplicate created`,
      );
      return this.subscriptionRepo.findOne({ where: { id: existing.id } }) as Promise<WebhookSubscription>;
    }

    const subscription = this.subscriptionRepo.create({
      workspaceId,
      ...data,
      ...(tenantId && { tenantId }),
      status: WebhookSubscriptionStatus.ACTIVE,
      failureCount: 0,
    });
    await this.subscriptionRepo.save(subscription);
    this.logger.log(`Created webhook subscription: ${subscription.name} (${subscription.id})`);
    return subscription;
  }

  /**
   * Get subscriptions for a workspace
   */
  async getSubscriptions(workspaceId: string): Promise<WebhookSubscription[]> {
    return this.subscriptionRepo.find({
      where: { workspaceId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Get a single subscription
   */
  async getSubscription(workspaceId: string, id: string): Promise<WebhookSubscription | null> {
    return this.subscriptionRepo.findOne({
      where: { id, workspaceId },
    });
  }

  /**
   * Update a subscription
   */
  async updateSubscription(
    workspaceId: string,
    id: string,
    data: Partial<{
      name: string;
      webhookUrl: string;
      secret: string;
      events: WebhookEventType[];
      status: WebhookSubscriptionStatus;
      metadata: Record<string, unknown>;
    }>,
  ): Promise<WebhookSubscription | null> {
    await this.subscriptionRepo.update({ id, workspaceId }, data as any);
    return this.subscriptionRepo.findOne({ where: { id, workspaceId } });
  }

  /**
   * Delete a subscription
   */
  async deleteSubscription(workspaceId: string, id: string): Promise<void> {
    await this.subscriptionRepo.delete({ id, workspaceId });
    this.logger.log(`Deleted webhook subscription: ${id}`);
  }

  /**
   * Test a webhook subscription
   */
  async testSubscription(workspaceId: string, id: string): Promise<{ success: boolean; error?: string }> {
    const subscription = await this.subscriptionRepo.findOne({
      where: { id, workspaceId },
    });

    if (!subscription) {
      return { success: false, error: 'Subscription not found' };
    }

    const testPayload: WebhookPayload = {
      event: WebhookEventType.MESSAGE_SENT,
      timestamp: new Date().toISOString(),
      data: {
        test: true,
        message: 'This is a test webhook from Callio',
        subscriptionId: subscription.id,
        subscriptionName: subscription.name,
      },
    };

    try {
      // Same HMAC contract as sendWebhook above:
      //   header ts  = epoch seconds
      //   signature  = HMAC-SHA256(secret, `${ts}.${rawBody}`)
      const tsEpoch = String(Math.floor(Date.now() / 1000));
      const payloadString = JSON.stringify(testPayload);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Callio-Event': testPayload.event,
        'X-Callio-Timestamp': tsEpoch,
        'X-Callio-Test': 'true',
      };

      if (subscription.secret) {
        const signature = this.signPayload(
          `${tsEpoch}.${payloadString}`,
          subscription.secret,
        );
        headers['X-Callio-Signature'] = signature;
      }

      await axios.post(subscription.webhookUrl, testPayload, {
        headers,
        timeout: this.WEBHOOK_TIMEOUT,
      });

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message || 'Unknown error' };
    }
  }
}
