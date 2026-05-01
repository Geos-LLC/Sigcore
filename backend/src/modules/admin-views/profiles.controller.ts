import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { SigcoreAuthGuard } from '../auth/sigcore-auth.guard';
import { WorkspaceId } from '../auth/decorators/workspace-id.decorator';
import { ProfilesService } from './profiles.service';
import { ProfileSummary, ProfileDetail } from './dto/admin-views.types';

@Controller('admin/profiles')
@UseGuards(SigcoreAuthGuard)
export class ProfilesController {
  constructor(private readonly profilesService: ProfilesService) {}

  @Get()
  async list(
    @WorkspaceId() workspaceId: string,
    @Query('platformId') platformId?: string,
    @Query('source') source?: string,
    @Query('businessId') businessId?: string,
    @Query('tenantId') tenantId?: string,
    @Query('hasPhones') hasPhones?: string,
    @Query('hasSharedPhone') hasSharedPhone?: string,
    @Query('hasExternalId') hasExternalId?: string,
    @Query('isDefault') isDefault?: string,
  ): Promise<{ data: ProfileSummary[] }> {
    const data = await this.profilesService.list(workspaceId, {
      platformId,
      source,
      businessId,
      tenantId,
      hasPhones: hasPhones === 'true' || hasPhones === '1',
      hasSharedPhone: hasSharedPhone === 'true' || hasSharedPhone === '1',
      hasExternalId: hasExternalId === 'true' || hasExternalId === '1',
      isDefault:
        isDefault === undefined ? undefined : isDefault === 'true' || isDefault === '1',
    });
    return { data };
  }

  @Get(':id')
  async detail(
    @WorkspaceId() workspaceId: string,
    @Param('id') id: string,
  ): Promise<{ data: ProfileDetail }> {
    const data = await this.profilesService.get(workspaceId, id);
    return { data };
  }
}
