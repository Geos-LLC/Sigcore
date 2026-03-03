import { Module, OnModuleInit, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { TenantsModule } from '../tenants/tenants.module';
import { CommunicationController } from './communication.controller';
import { ConversationsController } from './conversations.controller';
import { CallsController } from './calls.controller';
import { AnalyticsController } from './analytics.controller';
import { SendersController } from './senders.controller';
import { MessagesController } from './messages.controller';
import { PhoneNumbersController, PhoneNumbersV1Controller } from './phone-numbers.controller';
import { CommunicationService } from './communication.service';
import { SendersService } from './senders.service';
import { PhoneNumbersService } from './phone-numbers.service';
import { OpenPhoneProvider } from './providers/openphone.provider';
import { TwilioProvider } from './providers/twilio.provider';
import { WhatsAppWebProvider } from './providers/whatsapp-web.provider';
import { ProviderRegistry } from './providers/provider-registry.service';
import { EncryptionService } from '../../common/services/encryption.service';
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
    ]),
    forwardRef(() => WebhooksModule),
    forwardRef(() => TenantsModule),
  ],
  controllers: [
    CommunicationController,
    ConversationsController,
    CallsController,
    AnalyticsController,
    SendersController,
    MessagesController,
    PhoneNumbersController,
    PhoneNumbersV1Controller,
  ],
  providers: [
    CommunicationService,
    SendersService,
    PhoneNumbersService,
    OpenPhoneProvider,
    TwilioProvider,
    WhatsAppWebProvider,
    ProviderRegistry,
    EncryptionService,
  ],
  exports: [CommunicationService, SendersService, PhoneNumbersService, TwilioProvider, WhatsAppWebProvider, ProviderRegistry],
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
