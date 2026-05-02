import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SigcoreAuthGuard } from '../auth/sigcore-auth.guard';
import { WorkspaceId } from '../auth/decorators/workspace-id.decorator';
import {
  AssignedRow,
  AssignDto,
  AvailablePhoneRow,
  PhoneAssignmentsService,
  ProvisionAndAssignDto,
  ProvisionAndAssignResult,
} from './phone-assignments.service';

@Controller('admin')
@UseGuards(SigcoreAuthGuard)
export class PhoneAssignmentsController {
  constructor(private readonly svc: PhoneAssignmentsService) {}

  @Get('profiles/:id/available-phone-numbers')
  async listAvailable(
    @WorkspaceId() workspaceId: string,
    @Param('id') profileId: string,
  ): Promise<{
    data: { profileId: string; rows: AvailablePhoneRow[] };
  }> {
    const data = await this.svc.listAvailableForProfile(workspaceId, profileId);
    return { data };
  }

  @Post('phone-numbers/assign')
  @HttpCode(HttpStatus.CREATED)
  async assign(
    @WorkspaceId() workspaceId: string,
    @Body() dto: AssignDto,
  ): Promise<{ data: AssignedRow }> {
    const data = await this.svc.assign(workspaceId, dto);
    return { data };
  }

  @Post('phone-numbers/provision-and-assign')
  @HttpCode(HttpStatus.CREATED)
  async provisionAndAssign(
    @WorkspaceId() workspaceId: string,
    @Body() dto: ProvisionAndAssignDto,
  ): Promise<{ data: ProvisionAndAssignResult }> {
    const data = await this.svc.provisionAndAssign(workspaceId, dto);
    return { data };
  }
}
