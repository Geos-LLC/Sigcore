import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Business } from '../../database/entities/business.entity';
import { ProductWorkspace } from '../../database/entities/product-workspace.entity';
import { SharedCommunicationAsset } from '../../database/entities/shared-communication-asset.entity';
import { WorkspaceAssetLink } from '../../database/entities/workspace-asset-link.entity';
import { Tenant } from '../../database/entities/tenant.entity';
import { BusinessIdentityService } from './business-identity.service';
import { IdentityResolutionService } from './identity-resolution.service';
import { RoutingSelectionService } from './routing-selection.service';
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
    ]),
    SigcoreAuthModule,
  ],
  controllers: [BusinessIdentityController],
  providers: [
    BusinessIdentityService,
    IdentityResolutionService,
    RoutingSelectionService,
  ],
  exports: [
    BusinessIdentityService,
    IdentityResolutionService,
    RoutingSelectionService,
  ],
})
export class BusinessIdentityModule {}
