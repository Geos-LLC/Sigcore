import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SigcoreAuthGuard } from '../auth/sigcore-auth.guard';
import { WorkspaceId } from '../auth/decorators/workspace-id.decorator';
import { InventoryService } from './inventory.service';
import { InventoryRow, PhoneModelBadge } from './dto/admin-views.types';

@Controller('admin/inventory')
@UseGuards(SigcoreAuthGuard)
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Get('phone-numbers')
  async phoneNumbers(
    @WorkspaceId() workspaceId: string,
    @Query('model') model?: string,
    @Query('provider') provider?: string,
    @Query('limit') limit?: string,
  ): Promise<{ data: InventoryRow[] }> {
    const data = await this.inventoryService.listPhoneNumbers(workspaceId, {
      model: model as PhoneModelBadge | undefined,
      provider,
      limit: limit ? Number.parseInt(limit, 10) || undefined : undefined,
    });
    return { data };
  }
}
