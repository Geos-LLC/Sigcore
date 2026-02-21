import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as twilio from 'twilio';
import { SmsMessage, SmsDirection, SmsStatus } from '../../database/entities/sms-message.entity';
import { PhoneNumberAssignment, PhoneNumberType } from '../../database/entities/phone-number-assignment.entity';
import { CommunicationIntegration, ProviderType } from '../../database/entities/communication-integration.entity';
import { TenantIntegration } from '../../database/entities/tenant-integration.entity';
import { WebhookEventType } from '../../database/entities/webhook-subscription.entity';
import { EncryptionService } from '../../common/services/encryption.service';
import { OutboundWebhooksService } from '../webhooks/outbound-webhooks.service';
import { SendMessageDto } from './dto/send-message.dto';

@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);

  constructor(
    @InjectRepository(SmsMessage)
    private messageRepo: Repository<SmsMessage>,
    @InjectRepository(PhoneNumberAssignment)
    private assignmentRepo: Repository<PhoneNumberAssignment>,
    @InjectRepository(CommunicationIntegration)
    private integrationRepo: Repository<CommunicationIntegration>,
    @InjectRepository(TenantIntegration)
    private tenantIntegrationRepo: Repository<TenantIntegration>,
    private encryptionService: EncryptionService,
    private outboundWebhooks: OutboundWebhooksService,
    private config: ConfigService,
  ) {}

  // ──────────────────────────────────────────────────────────────
  // Outbound
  // ──────────────────────────────────────────────────────────────

  async sendMessage(workspaceId: string, dto: SendMessageDto) {
    const fromNumber = await this.resolveFromNumber(dto.businessId);
    const client = await this.getTwilioClient(workspaceId);
    const baseUrl = this.getBaseUrl();

    const twilioMsg = await client.messages.create({
      from: fromNumber,
      to: dto.toPhone,
      body: dto.body,
      statusCallback: `${baseUrl}/api/webhooks/twilio/sms-status`,
    });

    const saved = await this.messageRepo.save({
      businessId: dto.businessId,
      leadId: dto.leadId,
      direction: SmsDirection.OUTBOUND,
      fromNumber,
      toNumber: dto.toPhone,
      body: dto.body,
      status: SmsStatus.QUEUED,
      providerSid: twilioMsg.sid,
      automationId: dto.automationId,
      source: dto.source,
    });

    this.logger.log(`SMS sent: ${twilioMsg.sid} → ${dto.toPhone}`);
    return { messageId: saved.id, status: saved.status, providerSid: twilioMsg.sid };
  }

  // ──────────────────────────────────────────────────────────────
  // Inbound (called from webhook controller)
  // ──────────────────────────────────────────────────────────────

  async handleIncomingSms(
    toNumber: string,
    fromNumber: string,
    body: string,
    messageSid: string,
  ): Promise<void> {
    const assignment = await this.assignmentRepo.findOne({
      where: { numberE164: toNumber, active: true },
    });

    if (!assignment) {
      this.logger.warn(`No active phone number assignment for ${toNumber} — ignoring inbound SMS`);
      return;
    }

    const saved = await this.messageRepo.save({
      businessId: assignment.businessId,
      direction: SmsDirection.INBOUND,
      fromNumber,
      toNumber,
      body,
      status: SmsStatus.RECEIVED,
      providerSid: messageSid,
    });

    this.logger.log(`Inbound SMS saved: ${messageSid} from ${fromNumber} → business ${assignment.businessId}`);

    await this.outboundWebhooks.emitEvent(
      assignment.businessId,
      WebhookEventType.SMS_MESSAGE_RECEIVED,
      {
        messageId: saved.id,
        businessId: assignment.businessId,
        fromNumber,
        toNumber,
        body,
        direction: 'INBOUND',
        status: 'received',
        providerSid: messageSid,
        receivedAt: saved.createdAt.toISOString(),
      },
    );
  }

  // ──────────────────────────────────────────────────────────────
  // Delivery status (called from webhook controller)
  // ──────────────────────────────────────────────────────────────

  async handleSmsStatus(
    messageSid: string,
    messageStatus: string,
    errorCode?: string,
  ): Promise<void> {
    const statusMap: Record<string, SmsStatus> = {
      queued: SmsStatus.QUEUED,
      sent: SmsStatus.SENT,
      delivered: SmsStatus.DELIVERED,
      undelivered: SmsStatus.UNDELIVERED,
      failed: SmsStatus.FAILED,
    };

    const status = statusMap[messageStatus];
    if (!status) return;

    const message = await this.messageRepo.findOne({ where: { providerSid: messageSid } });
    if (!message) {
      this.logger.debug(`SMS status for unknown SID ${messageSid} — ignoring`);
      return;
    }

    await this.messageRepo.update(message.id, { status, ...(errorCode ? { errorCode } : {}) });

    if (status === SmsStatus.DELIVERED) {
      await this.outboundWebhooks.emitEvent(message.businessId, WebhookEventType.SMS_MESSAGE_DELIVERED, {
        messageId: message.id,
        businessId: message.businessId,
        providerSid: messageSid,
        status,
      });
    } else if (status === SmsStatus.FAILED || status === SmsStatus.UNDELIVERED) {
      await this.outboundWebhooks.emitEvent(message.businessId, WebhookEventType.SMS_MESSAGE_FAILED, {
        messageId: message.id,
        businessId: message.businessId,
        providerSid: messageSid,
        status,
        errorCode,
      });
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Phone number assignments
  // ──────────────────────────────────────────────────────────────

  async listAssignments(workspaceId: string) {
    return this.assignmentRepo.find({
      where: { businessId: workspaceId },
      order: { createdAt: 'DESC' },
    });
  }

  async upsertAssignment(
    workspaceId: string,
    dto: { numberE164: string; type: PhoneNumberType | 'BOT' | 'DEDICATED'; region?: string },
  ) {
    const existing = await this.assignmentRepo.findOne({
      where: { businessId: workspaceId, numberE164: dto.numberE164 },
    });
    if (existing) {
      await this.assignmentRepo.update(existing.id, {
        type: dto.type as PhoneNumberType,
        region: dto.region,
        active: true,
      });
      return this.assignmentRepo.findOne({ where: { id: existing.id } });
    }
    return this.assignmentRepo.save({
      businessId: workspaceId,
      numberE164: dto.numberE164,
      type: dto.type as PhoneNumberType,
      region: dto.region,
      active: true,
    });
  }

  async removeAssignment(workspaceId: string, id: string) {
    await this.assignmentRepo.delete({ id, businessId: workspaceId });
    return { deleted: true };
  }

  // ──────────────────────────────────────────────────────────────
  // Message history
  // ──────────────────────────────────────────────────────────────

  async listMessages(workspaceId: string) {
    return this.messageRepo.find({
      where: { businessId: workspaceId },
      order: { createdAt: 'DESC' },
      take: 50,
    });
  }

  // ──────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────

  private async resolveFromNumber(businessId: string): Promise<string> {
    // Prefer dedicated number; fall back to shared BOT number
    const dedicated = await this.assignmentRepo.findOne({
      where: { businessId, type: PhoneNumberType.DEDICATED, active: true },
    });
    if (dedicated) return dedicated.numberE164;

    const bot = await this.assignmentRepo.findOne({
      where: { businessId, type: PhoneNumberType.BOT, active: true },
    });
    if (bot) return bot.numberE164;

    throw new NotFoundException(`No active phone number assignment for business ${businessId}`);
  }

  private getBaseUrl(): string {
    const configured = this.config.get<string>('BASE_URL');
    if (configured) return configured.replace(/\/$/, '');
    const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
    if (railwayDomain) return `https://${railwayDomain}`;
    return 'http://localhost:3002';
  }

  private async getTwilioClient(workspaceId: string): Promise<twilio.Twilio> {
    const integration = await this.integrationRepo.findOne({
      where: { workspaceId, provider: ProviderType.TWILIO },
    });

    if (!integration?.credentialsEncrypted) {
      throw new Error(`No Twilio integration found for workspace ${workspaceId}`);
    }

    const credentials = JSON.parse(
      this.encryptionService.decrypt(integration.credentialsEncrypted),
    );

    return twilio(credentials.accountSid, credentials.authToken);
  }
}
