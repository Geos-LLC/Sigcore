import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Workspace } from '../../database/entities/workspace.entity';
import { Tenant } from '../../database/entities/tenant.entity';
import { ApiKey } from '../../database/entities/api-key.entity';
import { TenantPhoneNumber } from '../../database/entities/tenant-phone-number.entity';
import { PhoneNumberAssignment } from '../../database/entities/phone-number-assignment.entity';
import { WebhookSubscription } from '../../database/entities/webhook-subscription.entity';
import { SmsMessage } from '../../database/entities/sms-message.entity';
import { CommunicationConversation } from '../../database/entities/communication-conversation.entity';
import { CommunicationMessage } from '../../database/entities/communication-message.entity';
import { ProductWorkspace } from '../../database/entities/product-workspace.entity';
import { Business } from '../../database/entities/business.entity';
import { CommunicationBusiness } from '../../database/entities/communication-business.entity';
import { CommunicationProfile } from '../../database/entities/communication-profile.entity';
import { ProfilePhoneAssignment } from '../../database/entities/profile-phone-assignment.entity';
import { PlatformsController } from './platforms.controller';
import { PlatformsService } from './platforms.service';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { LegacyController } from './legacy.controller';
import { LegacyService } from './legacy.service';

/**
 * Read-only admin-views module.
 *
 * Powers the admin redesign first PR — see `ADMIN_REDESIGN.md` and the
 * implementation plan delivered for "Commit 1".
 *
 * All endpoints are GET-only and use the existing `SigcoreAuthGuard`. No
 * new auth, no new write paths, no DB migrations.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Workspace,
      Tenant,
      ApiKey,
      TenantPhoneNumber,
      PhoneNumberAssignment,
      WebhookSubscription,
      SmsMessage,
      CommunicationConversation,
      CommunicationMessage,
      ProductWorkspace,
      Business,
      CommunicationBusiness,
      CommunicationProfile,
      ProfilePhoneAssignment,
    ]),
  ],
  controllers: [PlatformsController, InventoryController, LegacyController],
  providers: [PlatformsService, InventoryService, LegacyService],
})
export class AdminViewsModule {}
