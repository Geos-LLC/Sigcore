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
import { WhatsAppWebProvider } from './providers/whatsapp-web.provider';

@Controller('conversations')
@UseGuards(SigcoreAuthGuard)
// TODO: re-enable @RequiresTenantScope() after fixing TypeORM tenant_id persistence
export class ConversationsController {
  constructor(
    private readonly communicationService: CommunicationService,
    private readonly whatsAppProvider: WhatsAppWebProvider,
  ) {}

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
    @Query('limit') limitStr?: string,
    @Query('before') before?: string,
  ) {
    const limit = Math.min(parseInt(limitStr || '30', 10) || 30, 100);
    const messages = await this.communicationService.getMessagesForConversation(
      workspaceId,
      conversationId,
      tenantId,
      { limit, before },
    );
    return {
      data: messages,
      meta: { hasMore: messages.length === limit },
    };
  }

  @Get('messages/:messageId/media')
  async getMessageMedia(
    @Param('messageId') messageId: string,
    @WorkspaceId() workspaceId: string,
    @Res() res: Response,
  ) {
    const message = await this.communicationService.getMessageById(messageId);
    if (!message) throw new NotFoundException('Message not found');

    const meta = (message.metadata || {}) as Record<string, unknown>;
    let mediaPath = meta.mediaPath as string | undefined;
    let mimetype = (meta.mediaMimetype as string) || 'application/octet-stream';

    // If media file exists locally, serve it
    if (mediaPath) {
      const fullPath = path.join(process.cwd(), 'uploads', mediaPath);
      if (fs.existsSync(fullPath)) {
        res.setHeader('Content-Type', mimetype);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        fs.createReadStream(fullPath).pipe(res);
        return;
      }
    }

    // On-demand download: ask WhatsApp service if message has media
    if (!meta.hasMedia) throw new NotFoundException('No media for this message');

    const chatId = meta.externalChatId as string;
    const providerMsgId = message.providerMessageId;
    if (!chatId || !providerMsgId) throw new NotFoundException('Missing chat/message ID for download');

    const media = await this.whatsAppProvider.downloadMedia(workspaceId, chatId, providerMsgId);
    if (!media?.data) throw new NotFoundException('Media no longer available');

    // Save to disk for future requests
    const mimeMap: Record<string, string> = {
      'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
      'video/mp4': '.mp4', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3',
    };
    const ext = mimeMap[media.mimetype] || '.bin';
    const mediaDir = path.join(process.cwd(), 'uploads', 'whatsapp', workspaceId);
    if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
    const filename = `${message.id}${ext}`;
    const filepath = path.join(mediaDir, filename);
    fs.writeFileSync(filepath, Buffer.from(media.data, 'base64'));

    // Update message metadata
    meta.mediaPath = `whatsapp/${workspaceId}/${filename}`;
    meta.mediaMimetype = media.mimetype;
    message.metadata = meta;
    await this.communicationService.updateMessageMetadata(message.id, meta);

    mimetype = media.mimetype;
    res.setHeader('Content-Type', mimetype);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    fs.createReadStream(filepath).pipe(res);
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
