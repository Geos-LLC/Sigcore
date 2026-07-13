import { Module } from '@nestjs/common';

import { EncryptionService } from '../../common/services/encryption.service';
import { ProvisioningController } from './provisioning.controller';
import { ProvisioningService } from './provisioning.service';

/**
 * Wave-2 Task 6B.2 — Communication Identity provisioning module.
 *
 * Deliberately isolated from IntegrationsModule to keep the ownership
 * boundary crisp: this module is the API surface where a consuming product
 * requests infrastructure; IntegrationsModule handles the pre-existing
 * integrations lifecycle (ensureIntegration, connect flows, etc.).
 *
 * The service reads/writes via a shared DataSource injected by TypeOrm's
 * root registration, so we don't need to import specific repositories here.
 * SigcoreAuthGuard is provided globally via SigcoreAuthModule.
 */
@Module({
  controllers: [ProvisioningController],
  providers: [ProvisioningService, EncryptionService],
})
export class ProvisioningModule {}
