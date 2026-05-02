import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SigcoreAuthGuard } from '../auth/sigcore-auth.guard';
import { WorkspaceId } from '../auth/decorators/workspace-id.decorator';
import { WorkspacesService } from './workspaces.service';
import { AdminListMeta, WorkspaceSummary } from './dto/admin-views.types';

@Controller('admin/workspaces')
@UseGuards(SigcoreAuthGuard)
export class WorkspacesController {
  constructor(private readonly workspacesService: WorkspacesService) {}

  @Get()
  async list(
    @WorkspaceId() workspaceId: string,
    @Query('platformId') platformId?: string,
    @Query('hideUnnamedTenants') hideUnnamedTenants?: string,
    @Query('includeZombies') includeZombies?: string,
    @Query('includeAnchors') includeAnchors?: string,
  ): Promise<{ data: WorkspaceSummary[]; meta: AdminListMeta }> {
    return this.workspacesService.list(workspaceId, {
      platformId,
      hideUnnamedTenants:
        hideUnnamedTenants === 'true' || hideUnnamedTenants === '1',
      includeZombies: includeZombies === 'true' || includeZombies === '1',
      includeAnchors: includeAnchors === 'true' || includeAnchors === '1',
    });
  }
}
