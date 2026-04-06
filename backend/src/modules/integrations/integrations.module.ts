import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { CommunicationIntegration } from '../../database/entities/communication-integration.entity';
import { TenantIntegration } from '../../database/entities/tenant-integration.entity';
import { Workspace } from '../../database/entities/workspace.entity';
import { ContactIdentity } from '../../database/entities/contact-identity.entity';
import { EncryptionService } from '../../common/services/encryption.service';
import { OpenPhoneProvider } from '../communication/providers/openphone.provider';
import { TwilioProvider } from '../communication/providers/twilio.provider';
import { TwilioVoiceService } from '../communication/twilio-voice.service';
import { WhatsAppWebProvider } from '../communication/providers/whatsapp-web.provider';
import { WhatsAppController } from './whatsapp.controller';
import { CommunicationModule } from '../communication/communication.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([CommunicationIntegration, TenantIntegration, Workspace, ContactIdentity]),
    forwardRef(() => CommunicationModule),
  ],
  controllers: [IntegrationsController, WhatsAppController],
  providers: [IntegrationsService, EncryptionService, OpenPhoneProvider, TwilioProvider, TwilioVoiceService, WhatsAppWebProvider],
  exports: [IntegrationsService, WhatsAppWebProvider],
})
export class IntegrationsModule {}
