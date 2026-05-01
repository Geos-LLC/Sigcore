import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommunicationConversation } from '../../database/entities/communication-conversation.entity';
import { CommunicationProfile } from '../../database/entities/communication-profile.entity';
import { ProfilePhoneAssignment } from '../../database/entities/profile-phone-assignment.entity';
import { TenantPhoneNumber } from '../../database/entities/tenant-phone-number.entity';
import { ResolveProfileForInboundService } from './resolve-profile-for-inbound.service';
import { ResolveProfileForOutboundService } from './resolve-profile-for-outbound.service';

/**
 * Routing module — pure read-only resolvers for inbound + outbound
 * profile/business selection. PR2: services + tests only. PR3 wires the
 * inbound resolver into the webhook paths; PR4 wires the outbound resolver
 * into POST /api/v1/messages.
 *
 * Provides:
 *   ResolveProfileForInboundService.resolve(input)  → { profileId, businessId, confidence }
 *   ResolveProfileForOutboundService.resolve(input) → { profileId, businessId, fromNumber, source } | throws RoutingError
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      CommunicationConversation,
      CommunicationProfile,
      ProfilePhoneAssignment,
      TenantPhoneNumber,
    ]),
  ],
  providers: [ResolveProfileForInboundService, ResolveProfileForOutboundService],
  exports: [ResolveProfileForInboundService, ResolveProfileForOutboundService],
})
export class RoutingModule {}
