import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
  Header,
  NotFoundException,
} from '@nestjs/common';
import { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { CommunicationService } from './communication.service';
import { SigcoreAuthGuard } from '../auth/sigcore-auth.guard';
import { WorkspaceId, TenantId } from '../auth/decorators/workspace-id.decorator';
import { RequiresTenantScope } from '../auth/decorators/require-tenant-scope.decorator';
import { SendMessageDto } from './dto';

@Controller('conversations')
@UseGuards(SigcoreAuthGuard)
// TODO: re-enable @RequiresTenantScope() after fixing TypeORM tenant_id persistence
export class ConversationsController {
  constructor(private readonly communicationService: CommunicationService) {}

  @Get()
  @Header('Cache-Control', 'no-cache, no-store, must-revalidate')
  async getConversations(
    @WorkspaceId() workspaceId: string,
    @TenantId() tenantId: string | null,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('phoneNumberId') phoneNumberId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('provider') provider?: string,
  ) {
    const pageNum = page ? parseInt(page, 10) : 1;
    const limitNum = limit ? parseInt(limit, 10) : 50;

    const result = await this.communicationService.getConversations(workspaceId, {
      tenantId,
      page: pageNum,
      limit: limitNum,
      search,
      phoneNumberId,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      provider: provider as 'openphone' | 'twilio' | undefined,
    });
    return { data: result.conversations, meta: result.meta };
  }

  @Get(':id/messages')
  @Header('Cache-Control', 'no-cache, no-store, must-revalidate')
  async getMessages(
    @Param('id') conversationId: string,
    @WorkspaceId() workspaceId: string,
    @TenantId() tenantId: string | null,
  ) {
    const messages = await this.communicationService.getMessagesForConversation(
      workspaceId,
      conversationId,
      tenantId,
    );
    return { data: messages };
  }

  @Get('messages/:messageId/media')
  async getMessageMedia(
    @Param('messageId') messageId: string,
    @Res() res: Response,
  ) {
    const message = await this.communicationService.getMessageById(messageId);
    if (!message) throw new NotFoundException('Message not found');

    const meta = (message.metadata || {}) as Record<string, unknown>;
    const mediaPath = meta.mediaPath as string;
    if (!mediaPath) throw new NotFoundException('No media for this message');

    const fullPath = path.join(process.cwd(), 'uploads', mediaPath);
    if (!fs.existsSync(fullPath)) throw new NotFoundException('Media file not found');

    const mimetype = (meta.mediaMimetype as string) || 'application/octet-stream';
    res.setHeader('Content-Type', mimetype);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    fs.createReadStream(fullPath).pipe(res);
  }

  @Get(':id/calls')
  @Header('Cache-Control', 'no-cache, no-store, must-revalidate')
  async getCalls(
    @Param('id') conversationId: string,
    @WorkspaceId() workspaceId: string,
    @TenantId() tenantId: string | null,
  ) {
    const calls = await this.communicationService.getCallsForConversation(
      workspaceId,
      conversationId,
      tenantId,
    );
    return { data: calls };
  }

  @Post(':id/sync')
  @HttpCode(HttpStatus.OK)
  async syncConversation(
    @Param('id') conversationId: string,
    @WorkspaceId() workspaceId: string,
  ) {
    const result = await this.communicationService.syncSingleConversation(
      workspaceId,
      conversationId,
    );
    return { data: result };
  }

  @Post(':id/messages')
  @HttpCode(HttpStatus.CREATED)
  async sendMessage(
    @Param('id') conversationId: string,
    @WorkspaceId() workspaceId: string,
    @Body() dto: SendMessageDto,
  ) {
    const message = await this.communicationService.sendMessageToConversation(
      workspaceId,
      conversationId,
      dto.body,
      dto.fromNumber,
    );
    return { data: message };
  }

  @Delete(':id/contact')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unlinkContact(
    @Param('id') conversationId: string,
    @WorkspaceId() workspaceId: string,
  ) {
    await this.communicationService.unlinkContactFromConversation(
      workspaceId,
      conversationId,
    );
  }
}
