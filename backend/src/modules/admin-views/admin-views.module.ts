import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TenantsModule } from '../tenants/tenants.module';
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
import { BusinessesController } from './businesses.controller';
import { BusinessesService } from './businesses.service';
import { ProfilesController } from './profiles.controller';
import { ProfilesService } from './profiles.service';
import { WorkspacesController } from './workspaces.controller';
import { WorkspacesService } from './workspaces.service';
import { PhoneAssignmentsController } from './phone-assignments.controller';
import { PhoneAssignmentsService } from './phone-assignments.service';
import { DebugConversationsController } from './debug-conversations.controller';

/**
 * Admin-views module — read paths plus the PR15 phone-assignment write path
 * (POST /admin/phone-numbers/assign). All endpoints use SigcoreAuthGuard.
 *
 * See `ADMIN_REDESIGN.md` for the broader plan.
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
    // PR16 — re-uses PhoneNumberProvisioningService for one-shot
    // provision-and-assign without duplicating Twilio purchase logic.
    TenantsModule,
  ],
  controllers: [
    PlatformsController,
    InventoryController,
    LegacyController,
    BusinessesController,
    ProfilesController,
    WorkspacesController,
    PhoneAssignmentsController,
    DebugConversationsController,
  ],
  providers: [
    PlatformsService,
    InventoryService,
    LegacyService,
    BusinessesService,
    ProfilesService,
    WorkspacesService,
    PhoneAssignmentsService,
  ],
})
export class AdminViewsModule {}
