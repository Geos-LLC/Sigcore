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
   * Emit an event to all active subscriptions for a workspace
   */
  async emitEvent(
    workspaceId: string,
    eventType: WebhookEventType,
    data: Record<string, unknown>,
  ): Promise<void> {
    const subscriptions = await this.subscriptionRepo.find({
      where: [
        { workspaceId, status: WebhookSubscriptionStatus.ACTIVE },
        { workspaceId, status: WebhookSubscriptionStatus.PAUSED },
      ],
    });

    // Filter to only subscriptions that listen for this event
    const relevantSubscriptions = subscriptions.filter((sub) =>
      sub.events.includes(eventType),
    );

    if (relevantSubscriptions.length === 0) {
      this.logger.debug(`No active subscriptions for event ${eventType} in workspace ${workspaceId}`);
      return;
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
   * Emit message event
   */
  async emitMessageEvent(
    workspaceId: string,
    eventType: WebhookEventType,
    message: CommunicationMessage,
    additionalData?: Record<string, unknown>,
  ): Promise<void> {
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
    };

    await this.emitEvent(workspaceId, eventType, data);
  }

  /**
   * Send webhook to a subscription
   */
  private async sendWebhook(
    subscription: WebhookSubscription,
    payload: WebhookPayload,
  ): Promise<void> {
    const payloadString = JSON.stringify(payload);

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Callio-Event': payload.event,
        'X-Callio-Timestamp': payload.timestamp,
      };

      // Add signature if secret is configured
      if (subscription.secret) {
        const signature = this.signPayload(payloadString, subscription.secret);
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
   * Create a webhook subscription
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
  ): Promise<WebhookSubscription> {
    const subscription = this.subscriptionRepo.create({
      workspaceId,
      ...data,
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
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Callio-Event': testPayload.event,
        'X-Callio-Timestamp': testPayload.timestamp,
        'X-Callio-Test': 'true',
      };

      if (subscription.secret) {
        const signature = this.signPayload(JSON.stringify(testPayload), subscription.secret);
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
