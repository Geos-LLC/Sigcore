import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TenantsController, TenantsV1Controller } from './tenants.controller';
import { TenantPortalController } from './tenant-portal.controller';
import { TenantsService } from './tenants.service';
import { PhoneNumberProvisioningService } from './phone-number-provisioning.service';
import {
  Tenant,
  TenantPhoneNumber,
  CommunicationIntegration,
  ApiKey,
  TenantIntegration,
  PhoneNumberOrder,
  PhoneNumberPricing,
  Workspace,
  WebhookSubscription,
} from '../../database/entities';
import { CommunicationBusiness } from '../../database/entities/communication-business.entity';
import { CommunicationProfile } from '../../database/entities/communication-profile.entity';
import { ProfilePhoneAssignment } from '../../database/entities/profile-phone-assignment.entity';
import { EncryptionService } from '../../common/services/encryption.service';
import { CommunicationModule } from '../communication/communication.module';
import { ApiModule } from '../api/api.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Tenant,
      TenantPhoneNumber,
      CommunicationIntegration,
      ApiKey,
      TenantIntegration,
      PhoneNumberOrder,
      PhoneNumberPricing,
      Workspace,
      WebhookSubscription,
      CommunicationBusiness,
      CommunicationProfile,
      ProfilePhoneAssignment,
    ]),
    forwardRef(() => CommunicationModule),
    forwardRef(() => ApiModule),
  ],
  controllers: [TenantsController, TenantsV1Controller, TenantPortalController],
  providers: [TenantsService, PhoneNumberProvisioningService, EncryptionService],
  exports: [TenantsService, PhoneNumberProvisioningService],
})
export class TenantsModule {}
