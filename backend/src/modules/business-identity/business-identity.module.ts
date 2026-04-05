import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Business } from '../../database/entities/business.entity';
import { ProductWorkspace } from '../../database/entities/product-workspace.entity';
import { SharedCommunicationAsset } from '../../database/entities/shared-communication-asset.entity';
import { WorkspaceAssetLink } from '../../database/entities/workspace-asset-link.entity';
import { Tenant } from '../../database/entities/tenant.entity';
import { TenantPhoneNumber } from '../../database/entities/tenant-phone-number.entity';
import { Workspace } from '../../database/entities/workspace.entity';
import { EndpointRoute } from '../../database/entities/endpoint-route.entity';
import { BusinessIdentityService } from './business-identity.service';
import { IdentityResolutionService } from './identity-resolution.service';
import { RoutingSelectionService } from './routing-selection.service';
import { BackfillService } from './backfill.service';
import { BusinessIdentityController } from './business-identity.controller';
import { SigcoreAuthModule } from '../auth/sigcore-auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Business,
      ProductWorkspace,
      SharedCommunicationAsset,
      WorkspaceAssetLink,
      Tenant,
      TenantPhoneNumber,
      Workspace,
      EndpointRoute,
    ]),
    SigcoreAuthModule,
  ],
  controllers: [BusinessIdentityController],
  providers: [
    BusinessIdentityService,
    IdentityResolutionService,
    RoutingSelectionService,
    BackfillService,
  ],
  exports: [
    BusinessIdentityService,
    IdentityResolutionService,
    RoutingSelectionService,
  ],
})
export class BusinessIdentityModule {}
