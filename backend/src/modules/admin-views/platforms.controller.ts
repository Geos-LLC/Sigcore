import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { SigcoreAuthGuard } from '../auth/sigcore-auth.guard';
import { WorkspaceId } from '../auth/decorators/workspace-id.decorator';
import { PlatformsService } from './platforms.service';
import { PlatformDetail, PlatformSummary } from './dto/admin-views.types';

@Controller('admin/platforms')
@UseGuards(SigcoreAuthGuard)
export class PlatformsController {
  constructor(private readonly platformsService: PlatformsService) {}

  @Get()
  async list(@WorkspaceId() workspaceId: string): Promise<{ data: PlatformSummary[] }> {
    const data = await this.platformsService.listPlatforms(workspaceId);
    return { data };
  }

  @Get(':id')
  async detail(
    @WorkspaceId() workspaceId: string,
    @Param('id') id: string,
  ): Promise<{ data: PlatformDetail }> {
    const data = await this.platformsService.getPlatform(workspaceId, id);
    return { data };
  }
}
