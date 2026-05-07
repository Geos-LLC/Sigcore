import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios from 'axios';
import * as crypto from 'crypto';
import { Tenant } from '../../database/entities/tenant.entity';
import { CommunicationMessage, MessageStatus } from '../../database/entities/communication-message.entity';

export enum TenantWebhookEventType {
  MESSAGE_STATUS_UPDATE = 'message.status_update',
  MESSAGE_DELIVERED = 'message.delivered',
  MESSAGE_FAILED = 'message.failed',
  MESSAGE_INBOUND = 'message.inbound',
}

export interface TenantWebhookPayload {
  event: TenantWebhookEventType;
  timestamp: string;
  data: {
    messageId: string;
    providerMessageId: string;
    status: string;
    fromNumber: string;
    toNumber: string;
    tenantId?: string;
    leadId?: string;
    errorCode?: string;
    errorMessage?: string;
    [key: string]: unknown;
  };
}

@Injectable()
export class TenantWebhooksService {
  private readonly logger = new Logger(TenantWebhooksService.name);
  private readonly WEBHOOK_TIMEOUT = 10000; // 10 seconds

  constructor(
    @InjectRepository(Tenant)
    private tenantRepo: Repository<Tenant>,
  ) {}

  /**
   * Forward delivery status update to tenant's webhook
   */
  async forwardStatusToTenant(
    message: CommunicationMessage,
    status: MessageStatus,
    errorCode?: string,
    errorMessage?: string,
  ): Promise<void> {
    // Extract tenantId from message metadata
    const tenantId = message.metadata?.tenantId as string | undefined;
    if (!tenantId) {
      this.logger.debug(`No tenantId in message ${message.id}, skipping tenant webhook`);
      return;
    }

    // Find tenant
    const tenant = await this.tenantRepo.findOne({
      where: { id: tenantId },
    });

    if (!tenant) {
      this.logger.warn(`Tenant ${tenantId} not found for message ${message.id}`);
      return;
    }

    if (!tenant.webhookUrl) {
      this.logger.debug(`Tenant ${tenantId} has no webhook URL configured`);
      return;
    }

    // Determine event type based on status
    let eventType: TenantWebhookEventType;
    switch (status) {
      case MessageStatus.DELIVERED:
        eventType = TenantWebhookEventType.MESSAGE_DELIVERED;
        break;
      case MessageStatus.FAILED:
        eventType = TenantWebhookEventType.MESSAGE_FAILED;
        break;
      default:
        eventType = TenantWebhookEventType.MESSAGE_STATUS_UPDATE;
    }

    // Build payload
    const payload: TenantWebhookPayload = {
      event: eventType,
      timestamp: new Date().toISOString(),
      data: {
        messageId: message.id,
        providerMessageId: message.providerMessageId,
        status,
        fromNumber: message.fromNumber,
        toNumber: message.toNumber,
        tenantId: message.metadata?.tenantId as string | undefined,
        leadId: message.metadata?.leadId as string | undefined,
        errorCode,
        errorMessage,
      },
    };

    // Send webhook
    await this.sendTenantWebhook(tenant, payload);
  }

  /**
   * Send webhook to tenant.
   *
   * Signature contract (aligned with the SF /lead-status verifier shape so
   * one HMAC implementation covers all SF inbound webhook routes; matches
   * outbound-webhooks.service.ts):
   *   X-Callio-Timestamp : epoch seconds, integer-as-string
   *   X-Callio-Signature : hex(HMAC-SHA256(secret, `${ts}.${rawBody}`))
   *
   * `payload.timestamp` (the ISO field on the JSON body) is preserved for
   * subscriber compatibility — only the header timestamp + HMAC binding changed.
   */
  private async sendTenantWebhook(
    tenant: Tenant,
    payload: TenantWebhookPayload,
  ): Promise<void> {
    const payloadString = JSON.stringify(payload);

    try {
      // Epoch seconds for HMAC + replay-window check on the receiver side.
      const tsEpoch = String(Math.floor(Date.now() / 1000));

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Callio-Event': payload.event,
        'X-Callio-Timestamp': tsEpoch,
        'X-Callio-Tenant-Id': tenant.id,
      };

      // Add signature if secret is configured
      if (tenant.webhookSecret) {
        const signature = this.signPayload(
          `${tsEpoch}.${payloadString}`,
          tenant.webhookSecret,
        );
        headers['X-Callio-Signature'] = signature;
      }

      this.logger.log(`Sending webhook to tenant ${tenant.name}: ${payload.event} -> ${tenant.webhookUrl}`);

      await axios.post(tenant.webhookUrl!, payload, {
        headers,
        timeout: this.WEBHOOK_TIMEOUT,
      });

      this.logger.log(`Webhook delivered to tenant ${tenant.name}: ${payload.event}`);
    } catch (error: any) {
      const errorMessage = error.message || 'Unknown error';
      this.logger.error(`Webhook delivery failed to tenant ${tenant.name}: ${errorMessage}`);
      // Don't throw - we don't want to fail the status update because of webhook delivery failure
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
}
