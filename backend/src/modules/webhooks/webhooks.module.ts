import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WebhooksController } from './webhooks.controller';
import { WebhookSubscriptionsController, WebhookSubscriptionsV1Controller, WebhookSubscriptionsAliasController } from './webhook-subscriptions.controller';
import { WebhooksService } from './webhooks.service';
import { TwilioWebhooksService } from './twilio-webhooks.service';
import { TenantWebhooksService } from './tenant-webhooks.service';
import { IdempotencyService } from './idempotency.service';
import { OutboundWebhooksService } from './outbound-webhooks.service';
import { WebhookRateLimitGuard } from './webhook-rate-limit.guard';
import { EncryptionService } from '../../common/services/encryption.service';
import { OpenPhoneProvider } from '../communication/providers/openphone.provider';
import { CallConnectService } from './call-connect.service';
import { CallConnectController } from './call-connect.controller';
import { InternalTwilioProxyController } from './internal-twilio-proxy.controller';
import { TenantVoiceForwarderService } from './tenant-voice-forwarder.service';
import { CallbackForwarderService } from './callback-forwarder.service';
import { EmailModule } from '../email/email.module';
import { MessagingModule } from '../messaging/messaging.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { RoutingModule } from '../routing/routing.module';
import {
  CommunicationIntegration,
  CommunicationConversation,
  CommunicationMessage,
  CommunicationCall,
  Workspace,
  WebhookEvent,
  WebhookSubscription,
  ApiKey,
  Tenant,
  TenantPhoneNumber,
  ContactIdentity,
  TenantIntegration,
  CallConnectSettings,
  CallConnectSession,
} from '../../database/entities';

@Module({
  imports: [
    MessagingModule,
    forwardRef(() => IntegrationsModule),
    RoutingModule,
    EmailModule,
    TypeOrmModule.forFeature([
      CommunicationIntegration,
      CommunicationConversation,
      CommunicationMessage,
      CommunicationCall,
      Workspace,
      WebhookEvent,
      WebhookSubscription,
      ApiKey,
      Tenant,
      TenantPhoneNumber,
      ContactIdentity,
      TenantIntegration,
      CallConnectSettings,
      CallConnectSession,
    ]),
  ],
  controllers: [
    WebhooksController,
    WebhookSubscriptionsController,
    WebhookSubscriptionsV1Controller,
    WebhookSubscriptionsAliasController,
    CallConnectController,
    InternalTwilioProxyController,
  ],
  providers: [
    WebhooksService,
    TwilioWebhooksService,
    TenantWebhooksService,
    IdempotencyService,
    OutboundWebhooksService,
    WebhookRateLimitGuard,
    EncryptionService,
    OpenPhoneProvider,
    CallConnectService,
    TenantVoiceForwarderService,
    CallbackForwarderService,
  ],
  exports: [TwilioWebhooksService, TenantWebhooksService, IdempotencyService, OutboundWebhooksService, CallbackForwarderService],
})
export class WebhooksModule {}
