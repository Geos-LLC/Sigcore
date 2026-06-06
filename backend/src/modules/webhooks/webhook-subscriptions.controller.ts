import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OutboundWebhooksService } from './outbound-webhooks.service';
import { SigcoreAuthGuard } from '../auth/sigcore-auth.guard';
import { WorkspaceId, TenantId } from '../auth/decorators/workspace-id.decorator';
import { Tenant } from '../../database/entities';
import {
  WebhookEventType,
  WebhookSubscriptionStatus,
} from '../../database/entities/webhook-subscription.entity';
import { IsString, IsUrl, IsArray, IsEnum, IsOptional, IsObject, IsIn } from 'class-validator';

class CreateWebhookSubscriptionDto {
  @IsString()
  name: string;

  @IsUrl()
  webhookUrl: string;

  @IsString()
  @IsOptional()
  secret?: string;

  @IsArray()
  @IsEnum(WebhookEventType, { each: true })
  events: WebhookEventType[];

  @IsObject()
  @IsOptional()
  metadata?: Record<string, unknown>;

  /**
   * Payload contract version. Omit to get the current default for new
   * subscriptions (`v2`, nested `data.metadata`). Pass `'v1'` only if
   * the consumer has a pre-2026-06 verifier that reads spread fields.
   */
  @IsIn(['v1', 'v2'])
  @IsOptional()
  payloadVersion?: 'v1' | 'v2';
}

class UpdateWebhookSubscriptionDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsUrl()
  @IsOptional()
  webhookUrl?: string;

  @IsString()
  @IsOptional()
  secret?: string;

  @IsArray()
  @IsEnum(WebhookEventType, { each: true })
  @IsOptional()
  events?: WebhookEventType[];

  @IsEnum(WebhookSubscriptionStatus)
  @IsOptional()
  status?: WebhookSubscriptionStatus;

  @IsObject()
  @IsOptional()
  metadata?: Record<string, unknown>;

  /**
   * Flip the payload contract version. The documented migration path:
   * consumer updates its verifier to handle the v2 nested-metadata
   * shape, then PATCHes `payloadVersion: 'v2'` here to switch over.
   * Effect is immediate on the next emitted event.
   */
  @IsIn(['v1', 'v2'])
  @IsOptional()
  payloadVersion?: 'v1' | 'v2';
}

/**
 * Webhook Subscriptions API
 *
 * Allows external systems like LeadBridge to register for outbound webhooks
 */
@Controller('webhook-subscriptions')
@UseGuards(SigcoreAuthGuard)
export class WebhookSubscriptionsController {
  constructor(
    private readonly outboundWebhooksService: OutboundWebhooksService,
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
  ) {}

  /**
   * List all webhook subscriptions
   */
  @Get()
  async listSubscriptions(@WorkspaceId() workspaceId: string) {
    const subscriptions = await this.outboundWebhooksService.getSubscriptions(workspaceId);
    return { data: subscriptions };
  }

  /**
   * Get a single subscription
   */
  @Get(':id')
  async getSubscription(
    @WorkspaceId() workspaceId: string,
    @Param('id') id: string,
  ) {
    const subscription = await this.outboundWebhooksService.getSubscription(workspaceId, id);
    if (!subscription) {
      throw new NotFoundException('Webhook subscription not found');
    }
    return { data: subscription };
  }

  /**
   * Create a new webhook subscription
   *
   * @example
   * POST /api/webhook-subscriptions
   * {
   *   "name": "LeadBridge Notifications",
   *   "webhookUrl": "https://api.leadbridge.com/webhooks/callio",
   *   "secret": "your-webhook-secret",
   *   "events": ["message.delivered", "message.failed", "message.inbound"]
   * }
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createSubscription(
    @WorkspaceId() workspaceId: string,
    @TenantId() tenantId: string | undefined,
    @Body() dto: CreateWebhookSubscriptionDto,
  ) {
    // Auto-fill secret from tenant record if not provided
    if (!dto.secret && tenantId) {
      const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
      if (tenant?.webhookSecret) {
        dto.secret = tenant.webhookSecret;
      }
    }
    const subscription = await this.outboundWebhooksService.createSubscription(workspaceId, dto, tenantId);
    return { data: subscription };
  }

  /**
   * Update a webhook subscription
   */
  @Patch(':id')
  async updateSubscription(
    @WorkspaceId() workspaceId: string,
    @Param('id') id: string,
    @Body() dto: UpdateWebhookSubscriptionDto,
  ) {
    const subscription = await this.outboundWebhooksService.updateSubscription(workspaceId, id, dto);
    if (!subscription) {
      throw new NotFoundException('Webhook subscription not found');
    }
    return { data: subscription };
  }

  /**
   * Delete a webhook subscription
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteSubscription(
    @WorkspaceId() workspaceId: string,
    @Param('id') id: string,
  ) {
    await this.outboundWebhooksService.deleteSubscription(workspaceId, id);
  }

  /**
   * Test a webhook subscription
   * Sends a test event to verify the webhook URL is working
   */
  @Post(':id/test')
  async testSubscription(
    @WorkspaceId() workspaceId: string,
    @Param('id') id: string,
  ) {
    const result = await this.outboundWebhooksService.testSubscription(workspaceId, id);
    return { data: result };
  }

  /**
   * Get the tenant's webhook secret
   * Tenants use this to retrieve their signing secret for verifying inbound webhooks.
   */
  @Get('secret')
  async getWebhookSecret(
    @WorkspaceId() workspaceId: string,
    @TenantId() tenantId: string | undefined,
  ) {
    if (!tenantId) {
      throw new NotFoundException('Webhook secret is only available for tenant API key auth');
    }
    const tenant = await this.tenantRepo.findOne({ where: { id: tenantId, workspaceId } });
    if (!tenant?.webhookSecret) {
      throw new NotFoundException('No webhook secret configured for this tenant');
    }
    return { data: { secret: tenant.webhookSecret } };
  }

  /**
   * Get available event types
   */
  @Get('events/types')
  getEventTypes() {
    return {
      data: Object.values(WebhookEventType).map((event) => ({
        event,
        description: this.getEventDescription(event),
      })),
    };
  }

  private getEventDescription(event: WebhookEventType): string {
    const descriptions: Record<WebhookEventType, string> = {
      [WebhookEventType.MESSAGE_SENT]: 'Triggered when a message is sent',
      [WebhookEventType.MESSAGE_DELIVERED]: 'Triggered when a message is delivered',
      [WebhookEventType.MESSAGE_FAILED]: 'Triggered when a message fails to deliver',
      [WebhookEventType.MESSAGE_INBOUND]: 'Triggered when an inbound message is received',
      [WebhookEventType.CALL_STARTED]: 'Triggered when a call starts',
      [WebhookEventType.CALL_INBOUND]: 'Triggered when an inbound voice call arrives at a Twilio number',
      [WebhookEventType.CALL_COMPLETED]: 'Triggered when a call completes',
      [WebhookEventType.CALL_MISSED]: 'Triggered when a call is missed (no-answer/busy/failed)',
      [WebhookEventType.CALL_CONNECT_SESSION_CREATED]: 'Call Connect: session created for a new lead',
      [WebhookEventType.CALL_CONNECT_AGENT_RINGING]: 'Call Connect: agent phone is ringing',
      [WebhookEventType.CALL_CONNECT_AGENT_ACCEPTED]: 'Call Connect: agent accepted the call',
      [WebhookEventType.CALL_CONNECT_LEAD_RINGING]: 'Call Connect: lead phone is ringing',
      [WebhookEventType.CALL_CONNECT_BRIDGED]: 'Call Connect: agent and lead are bridged',
      [WebhookEventType.CALL_CONNECT_VOICEMAIL_DROP]: 'Call Connect: voicemail drop started on lead voicemail',
      [WebhookEventType.CALL_CONNECT_ENDED]: 'Call Connect: session ended successfully',
      [WebhookEventType.CALL_CONNECT_FAILED]: 'Call Connect: session failed',
      [WebhookEventType.SMS_MESSAGE_RECEIVED]: 'Triggered when an inbound SMS is received',
      [WebhookEventType.SMS_MESSAGE_DELIVERED]: 'Triggered when an outbound SMS is delivered',
      [WebhookEventType.SMS_MESSAGE_FAILED]: 'Triggered when an outbound SMS fails to deliver',
      [WebhookEventType.WHATSAPP_MESSAGE_INBOUND]: 'Triggered when an inbound WhatsApp message is received',
      [WebhookEventType.WHATSAPP_MESSAGE_OUTBOUND]: 'Triggered when an outbound WhatsApp message is sent',
      [WebhookEventType.WHATSAPP_MESSAGE_DELIVERED]: 'Triggered when a WhatsApp message is delivered/read',
      [WebhookEventType.WHATSAPP_STATUS_CHANGE]: 'Triggered when WhatsApp connection status changes',
    };
    return descriptions[event] || 'No description available';
  }
}

/**
 * Alias controller at /api/webhooks/subscriptions
 * This matches the path documented in the LeadBridge integration guide.
 */
@Controller('webhooks/subscriptions')
@UseGuards(SigcoreAuthGuard)
export class WebhookSubscriptionsAliasController {
  constructor(
    private readonly outboundWebhooksService: OutboundWebhooksService,
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
  ) {}

  @Get()
  async listSubscriptions(@WorkspaceId() workspaceId: string) {
    const subscriptions = await this.outboundWebhooksService.getSubscriptions(workspaceId);
    return { data: subscriptions };
  }

  @Get(':id')
  async getSubscription(@WorkspaceId() workspaceId: string, @Param('id') id: string) {
    const subscription = await this.outboundWebhooksService.getSubscription(workspaceId, id);
    if (!subscription) throw new NotFoundException('Webhook subscription not found');
    return { data: subscription };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createSubscription(
    @WorkspaceId() workspaceId: string,
    @TenantId() tenantId: string | undefined,
    @Body() dto: CreateWebhookSubscriptionDto,
  ) {
    if (!dto.secret && tenantId) {
      const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
      if (tenant?.webhookSecret) dto.secret = tenant.webhookSecret;
    }
    const subscription = await this.outboundWebhooksService.createSubscription(workspaceId, dto, tenantId);
    return { data: subscription };
  }

  @Patch(':id')
  async updateSubscription(
    @WorkspaceId() workspaceId: string,
    @Param('id') id: string,
    @Body() dto: UpdateWebhookSubscriptionDto,
  ) {
    const subscription = await this.outboundWebhooksService.updateSubscription(workspaceId, id, dto);
    if (!subscription) throw new NotFoundException('Webhook subscription not found');
    return { data: subscription };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteSubscription(@WorkspaceId() workspaceId: string, @Param('id') id: string) {
    await this.outboundWebhooksService.deleteSubscription(workspaceId, id);
  }

  @Post(':id/test')
  async testSubscription(@WorkspaceId() workspaceId: string, @Param('id') id: string) {
    const result = await this.outboundWebhooksService.testSubscription(workspaceId, id);
    return { data: result };
  }

  @Get('events/types')
  getEventTypes() {
    return {
      data: Object.values(WebhookEventType).map((event) => ({ event })),
    };
  }
}

/**
 * Webhook Subscriptions API for external systems (API Key auth)
 */
@Controller('v1/webhook-subscriptions')
@UseGuards(SigcoreAuthGuard)
export class WebhookSubscriptionsV1Controller {
  constructor(
    private readonly outboundWebhooksService: OutboundWebhooksService,
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
  ) {}

  @Get()
  async listSubscriptions(@WorkspaceId() workspaceId: string) {
    const subscriptions = await this.outboundWebhooksService.getSubscriptions(workspaceId);
    return { data: subscriptions };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createSubscription(
    @WorkspaceId() workspaceId: string,
    @TenantId() tenantId: string | undefined,
    @Body() dto: CreateWebhookSubscriptionDto,
  ) {
    // Auto-fill secret from tenant record if not provided
    if (!dto.secret && tenantId) {
      const tenant = await this.tenantRepo.findOne({ where: { id: tenantId } });
      if (tenant?.webhookSecret) {
        dto.secret = tenant.webhookSecret;
      }
    }
    const subscription = await this.outboundWebhooksService.createSubscription(workspaceId, dto, tenantId);
    return { data: subscription };
  }

  @Patch(':id')
  async updateSubscription(
    @WorkspaceId() workspaceId: string,
    @Param('id') id: string,
    @Body() dto: UpdateWebhookSubscriptionDto,
  ) {
    const subscription = await this.outboundWebhooksService.updateSubscription(workspaceId, id, dto);
    if (!subscription) {
      throw new NotFoundException('Webhook subscription not found');
    }
    return { data: subscription };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteSubscription(
    @WorkspaceId() workspaceId: string,
    @Param('id') id: string,
  ) {
    await this.outboundWebhooksService.deleteSubscription(workspaceId, id);
  }

  @Post(':id/test')
  async testSubscription(
    @WorkspaceId() workspaceId: string,
    @Param('id') id: string,
  ) {
    const result = await this.outboundWebhooksService.testSubscription(workspaceId, id);
    return { data: result };
  }

  @Get('secret')
  async getWebhookSecret(
    @WorkspaceId() workspaceId: string,
    @TenantId() tenantId: string | undefined,
  ) {
    if (!tenantId) {
      throw new NotFoundException('Webhook secret is only available for tenant API key auth');
    }
    const tenant = await this.tenantRepo.findOne({ where: { id: tenantId, workspaceId } });
    if (!tenant?.webhookSecret) {
      throw new NotFoundException('No webhook secret configured for this tenant');
    }
    return { data: { secret: tenant.webhookSecret } };
  }
}
