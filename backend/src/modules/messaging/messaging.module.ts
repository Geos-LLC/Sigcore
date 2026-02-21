import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MessagingService } from './messaging.service';
import { MessagingController } from './messaging.controller';
import { SmsMessage } from '../../database/entities/sms-message.entity';
import { PhoneNumberAssignment } from '../../database/entities/phone-number-assignment.entity';
import {
  CommunicationIntegration,
  TenantIntegration,
  WebhookSubscription,
} from '../../database/entities';
import { EncryptionService } from '../../common/services/encryption.service';
import { OutboundWebhooksService } from '../webhooks/outbound-webhooks.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SmsMessage,
      PhoneNumberAssignment,
      CommunicationIntegration,
      TenantIntegration,
      WebhookSubscription,
    ]),
  ],
  controllers: [MessagingController],
  providers: [MessagingService, EncryptionService, OutboundWebhooksService],
  exports: [MessagingService],
})
export class MessagingModule {}
