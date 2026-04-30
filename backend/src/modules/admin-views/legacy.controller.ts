import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SigcoreAuthGuard } from '../auth/sigcore-auth.guard';
import { WorkspaceId } from '../auth/decorators/workspace-id.decorator';
import { LegacyService } from './legacy.service';
import {
  InventoryRow,
  LegacyAssignmentGroup,
  LegacySmsRow,
} from './dto/admin-views.types';

@Controller('admin/legacy')
@UseGuards(SigcoreAuthGuard)
export class LegacyController {
  constructor(private readonly legacyService: LegacyService) {}

  @Get('assignments')
  async assignments(
    @WorkspaceId() workspaceId: string,
  ): Promise<{ data: LegacyAssignmentGroup[] }> {
    const data = await this.legacyService.listAssignments(workspaceId);
    return { data };
  }

  @Get('duplications')
  async duplications(
    @WorkspaceId() workspaceId: string,
  ): Promise<{ data: InventoryRow[] }> {
    const data = await this.legacyService.listDuplications(workspaceId);
    return { data };
  }

  @Get('sms-messages')
  async smsMessages(
    @WorkspaceId() workspaceId: string,
    @Query('limit') limit?: string,
  ): Promise<{ data: LegacySmsRow[] }> {
    const data = await this.legacyService.listSmsMessages(
      workspaceId,
      limit ? Number.parseInt(limit, 10) || undefined : undefined,
    );
    return { data };
  }
}
