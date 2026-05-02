import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { SigcoreAuthGuard } from '../auth/sigcore-auth.guard';
import { WorkspaceId } from '../auth/decorators/workspace-id.decorator';
import { BusinessesService } from './businesses.service';
import {
  AdminListMeta,
  BusinessSummary,
  BusinessDetail,
} from './dto/admin-views.types';

@Controller('admin/businesses')
@UseGuards(SigcoreAuthGuard)
export class BusinessesController {
  constructor(private readonly businessesService: BusinessesService) {}

  @Get()
  async list(
    @WorkspaceId() workspaceId: string,
    @Query('platformId') platformId?: string,
    @Query('source') source?: string,
    @Query('hasPhones') hasPhones?: string,
    @Query('hasSharedPhone') hasSharedPhone?: string,
    @Query('hasExternalId') hasExternalId?: string,
    @Query('workspaceKey') workspaceKey?: string,
    @Query('includeZombies') includeZombies?: string,
  ): Promise<{ data: BusinessSummary[]; meta: AdminListMeta }> {
    return this.businessesService.list(workspaceId, {
      platformId,
      source,
      hasPhones: hasPhones === 'true' || hasPhones === '1',
      hasSharedPhone: hasSharedPhone === 'true' || hasSharedPhone === '1',
      hasExternalId: hasExternalId === 'true' || hasExternalId === '1',
      workspaceKey,
      includeZombies: includeZombies === 'true' || includeZombies === '1',
    });
  }

  @Get(':id')
  async detail(
    @WorkspaceId() workspaceId: string,
    @Param('id') id: string,
  ): Promise<{ data: BusinessDetail }> {
    const data = await this.businessesService.get(workspaceId, id);
    return { data };
  }
}
