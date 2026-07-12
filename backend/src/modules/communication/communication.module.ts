import { Module, OnModuleInit, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { TenantsModule } from '../tenants/tenants.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { RoutingModule } from '../routing/routing.module';
import { CommunicationController } from './communication.controller';
import { ConversationsController } from './conversations.controller';
import { CallsController, CallsV1Controller } from './calls.controller';
import { AnalyticsController } from './analytics.controller';
import { SendersController } from './senders.controller';
import { MessagesController } from './messages.controller';
import {
  PhoneNumbersController,
  PhoneNumbersV1Controller,
  PhoneNumbersWebhookConfigController,
} from './phone-numbers.controller';
import { CommunicationService } from './communication.service';
import { SendersService } from './senders.service';
import { PhoneNumbersService } from './phone-numbers.service';
import { OpenPhoneProvider } from './providers/openphone.provider';
import { TwilioProvider } from './providers/twilio.provider';
import { TwilioVoiceService } from './twilio-voice.service';
import { WhatsAppWebProvider } from './providers/whatsapp-web.provider';
import { ProviderRegistry } from './providers/provider-registry.service';
import { EncryptionService } from '../../common/services/encryption.service';
import { IntegrationResourceGuardService } from '../../common/guards/integration-resource-guard.service';
import { IntegrationResourceGuard } from '../../common/guards/integration-resource.guard';
import { Tenant } from '../../database/entities/tenant.entity';
import {
  CommunicationIntegration,
  CommunicationConversation,
  CommunicationMessage,
  CommunicationCall,
  Sender,
  ContactIdentity,
  Workspace,
  ApiKey,
  TenantIntegration,
  TenantPhoneNumber,
  ProfilePhoneAssignment,
  CommunicationProfile,
} from '../../database/entities';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CommunicationIntegration,
      CommunicationConversation,
      CommunicationMessage,
      CommunicationCall,
      Sender,
      ContactIdentity,
      Workspace,
      ApiKey,
      TenantIntegration,
      TenantPhoneNumber,
      ProfilePhoneAssignment,
      CommunicationProfile,
      Tenant,
    ]),
    forwardRef(() => WebhooksModule),
    forwardRef(() => TenantsModule),
    forwardRef(() => IntegrationsModule),
    RoutingModule,
  ],
  controllers: [
    CommunicationController,
    ConversationsController,
    CallsController,
    CallsV1Controller,
    AnalyticsController,
    SendersController,
    MessagesController,
    PhoneNumbersController,
    PhoneNumbersV1Controller,
    // Wave-2 Task 4 (2026-07-12): dedicated controller for
    // POST /v1/phone-numbers/:tpnId/webhook-config so we can stack
    // @UseIntegrationResourceGuard('tpnId') without disturbing the
    // pre-existing v1 phone-number routes which have different auth.
    PhoneNumbersWebhookConfigController,
  ],
  providers: [
    CommunicationService,
    SendersService,
    PhoneNumbersService,
    OpenPhoneProvider,
    TwilioProvider,
    TwilioVoiceService,
    WhatsAppWebProvider,
    ProviderRegistry,
    EncryptionService,
    IntegrationResourceGuardService,
    IntegrationResourceGuard,
  ],
  exports: [CommunicationService, SendersService, PhoneNumbersService, TwilioProvider, TwilioVoiceService, WhatsAppWebProvider, ProviderRegistry, IntegrationResourceGuardService],
})
export class CommunicationModule implements OnModuleInit {
  constructor(
    private readonly providerRegistry: ProviderRegistry,
    private readonly openPhoneProvider: OpenPhoneProvider,
    private readonly twilioProvider: TwilioProvider,
  ) {}

  onModuleInit() {
    // Register all providers on module initialization
    this.providerRegistry.registerProvider(this.openPhoneProvider);
    this.providerRegistry.registerProvider(this.twilioProvider);
  }
}
