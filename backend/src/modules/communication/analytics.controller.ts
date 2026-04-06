import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SigcoreAuthGuard } from '../auth/sigcore-auth.guard';
import { WorkspaceId } from '../auth/decorators/workspace-id.decorator';
import { RequiresTenantScope } from '../auth/decorators/require-tenant-scope.decorator';
import { CommunicationService } from './communication.service';

export interface AnalyticsQuery {
  period?: 'week' | 'month' | 'year' | 'custom';
  startDate?: string; // ISO date string
  endDate?: string; // ISO date string
  phoneNumber?: string; // Filter by phone number (your OpenPhone line)
}

@Controller('analytics')
@UseGuards(SigcoreAuthGuard)
@RequiresTenantScope()
export class AnalyticsController {
  constructor(private readonly communicationService: CommunicationService) {}

  @Get()
  async getAnalytics(
    @WorkspaceId() workspaceId: string,
    @Query() query: AnalyticsQuery,
  ) {
    const analytics = await this.communicationService.getAnalytics(workspaceId, {
      period: query.period,
      startDate: query.startDate ? new Date(query.startDate) : undefined,
      endDate: query.endDate ? new Date(query.endDate) : undefined,
      phoneNumber: query.phoneNumber,
    });
    return { data: analytics };
  }
}
