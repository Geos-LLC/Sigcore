import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { CommunicationIntegration } from '../../database/entities/communication-integration.entity';
import { TenantIntegration } from '../../database/entities/tenant-integration.entity';
import { Workspace } from '../../database/entities/workspace.entity';
import { ContactIdentity } from '../../database/entities/contact-identity.entity';
import { OpenPhoneContactSnapshot } from '../../database/entities/openphone-contact-snapshot.entity';
import { CommunicationParticipant } from '../../database/entities/communication-participant.entity';
import { EncryptionService } from '../../common/services/encryption.service';
import { OpenPhoneProvider } from '../communication/providers/openphone.provider';
import { TwilioProvider } from '../communication/providers/twilio.provider';
import { TwilioVoiceService } from '../communication/twilio-voice.service';
import { WhatsAppWebProvider } from '../communication/providers/whatsapp-web.provider';
import { WhatsAppController } from './whatsapp.controller';
import { SfWhatsAppController } from './sf-whatsapp.controller';
import { SfAuthGuard } from '../auth/sf-auth.guard';
import { CommunicationModule } from '../communication/communication.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CommunicationIntegration,
      TenantIntegration,
      Workspace,
      ContactIdentity,
      OpenPhoneContactSnapshot,
      CommunicationParticipant,
    ]),
    forwardRef(() => CommunicationModule),
  ],
  controllers: [IntegrationsController, WhatsAppController, SfWhatsAppController],
  providers: [IntegrationsService, EncryptionService, OpenPhoneProvider, TwilioProvider, TwilioVoiceService, WhatsAppWebProvider, SfAuthGuard],
  exports: [IntegrationsService, WhatsAppWebProvider],
})
export class IntegrationsModule {}
