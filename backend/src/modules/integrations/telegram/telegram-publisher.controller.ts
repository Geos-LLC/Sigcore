import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SigcoreAuthGuard } from '../../auth/sigcore-auth.guard';
import { TenantId, WorkspaceId } from '../../auth/decorators/workspace-id.decorator';
import { TelegramPublisherService } from './telegram-publisher.service';
import {
  PublishPlacementDto,
  SubscribeDto,
  VerifyChatDto,
} from './dto/publish-placement.dto';

@Controller('integrations/telegram')
@UseGuards(SigcoreAuthGuard)
export class TelegramPublisherController {
  constructor(private readonly service: TelegramPublisherService) {}

  @Post('subscribe')
  async subscribe(
    @WorkspaceId() workspaceId: string,
    @TenantId() tenantId: string | null,
    @Body() body: SubscribeDto,
    @Query('mode') modeQuery?: string,
  ) {
    const mode: 'bot' | 'account' = modeQuery === 'account' ? 'account' : 'bot';
    if (modeQuery && modeQuery !== 'bot' && modeQuery !== 'account') {
      throw new BadRequestException(`Invalid mode '${modeQuery}' — expected 'bot' or 'account'`);
    }
    return this.service.subscribe(workspaceId, tenantId || undefined, body?.displayName, mode);
  }

  @Get('status')
  async status(@WorkspaceId() workspaceId: string) {
    return this.service.getStatus(workspaceId);
  }

  @Post('verify-chat')
  async verifyChat(@WorkspaceId() workspaceId: string, @Body() body: VerifyChatDto) {
    return this.service.verifyChat(workspaceId, body.chatRef, body.probe);
  }

  @Post('publish')
  async publish(
    @WorkspaceId() workspaceId: string,
    @TenantId() tenantId: string | null,
    @Body() body: PublishPlacementDto,
  ) {
    return this.service.publish(workspaceId, tenantId || undefined, body);
  }

  @Post('placements/:id/cancel')
  async cancel(@WorkspaceId() workspaceId: string, @Param('id') id: string) {
    return this.service.cancel(id, workspaceId);
  }

  @Get('placements/:id')
  async getPlacement(@WorkspaceId() workspaceId: string, @Param('id') id: string) {
    return this.service.getPlacement(id, workspaceId);
  }
}
