import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SigcoreAuthGuard } from '../auth/sigcore-auth.guard';
import { WorkspaceId } from '../auth/decorators/workspace-id.decorator';
import { WorkspacesService } from './workspaces.service';
import { WorkspaceSummary } from './dto/admin-views.types';

@Controller('admin/workspaces')
@UseGuards(SigcoreAuthGuard)
export class WorkspacesController {
  constructor(private readonly workspacesService: WorkspacesService) {}

  @Get()
  async list(
    @WorkspaceId() workspaceId: string,
    @Query('platformId') platformId?: string,
    @Query('hideUnnamedTenants') hideUnnamedTenants?: string,
  ): Promise<{ data: WorkspaceSummary[] }> {
    const data = await this.workspacesService.list(workspaceId, {
      platformId,
      hideUnnamedTenants:
        hideUnnamedTenants === 'true' || hideUnnamedTenants === '1',
    });
    return { data };
  }
}
