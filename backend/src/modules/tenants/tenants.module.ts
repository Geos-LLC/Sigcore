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
} from '../../database/entities';
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
    ]),
    forwardRef(() => CommunicationModule),
    forwardRef(() => ApiModule),
  ],
  controllers: [TenantsController, TenantsV1Controller, TenantPortalController],
  providers: [TenantsService, PhoneNumberProvisioningService, EncryptionService],
  exports: [TenantsService, PhoneNumberProvisioningService],
})
export class TenantsModule {}
