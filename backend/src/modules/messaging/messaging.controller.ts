import { Controller, Post, Body, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { SigcoreAuthGuard } from '../auth/sigcore-auth.guard';
import { WorkspaceId } from '../auth/decorators/workspace-id.decorator';
import { MessagingService } from './messaging.service';
import { SendMessageDto } from './dto/send-message.dto';

/**
 * Internal SMS API consumed by LeadBridge.
 * All routes require an X-API-Key workspace API key.
 *
 * POST /api/internal/messages/send
 */
@Controller('internal/messages')
@UseGuards(SigcoreAuthGuard)
export class MessagingController {
  constructor(private readonly messagingService: MessagingService) {}

  /**
   * Send an outbound SMS to a lead.
   *
   * POST /api/internal/messages/send
   */
  @Post('send')
  @HttpCode(HttpStatus.OK)
  async send(@WorkspaceId() workspaceId: string, @Body() dto: SendMessageDto) {
    return this.messagingService.sendMessage(workspaceId, dto);
  }
}
