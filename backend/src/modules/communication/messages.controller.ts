import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { CommunicationService } from './communication.service';
import { CreateMessageDto } from './dto/create-message.dto';
import { SigcoreAuthGuard } from '../auth/sigcore-auth.guard';
import { WorkspaceId } from '../auth/decorators/workspace-id.decorator';
import { RequiresTenantScope } from '../auth/decorators/require-tenant-scope.decorator';

/**
 * New /messages endpoint that uses senderId instead of fromNumber
 * This is the preferred way to send messages in the new architecture
 */
@Controller('messages')
@UseGuards(SigcoreAuthGuard)
@RequiresTenantScope()
export class MessagesController {
  constructor(private readonly communicationService: CommunicationService) {}

  /**
   * Send a message using senderId
   *
   * @example
   * POST /messages
   * {
   *   "body": "Hello from the new API!",
   *   "senderId": "uuid-of-sender",
   *   "contactId": "uuid-of-contact"
   * }
   *
   * Or with conversationId:
   * {
   *   "body": "Hello!",
   *   "senderId": "uuid-of-sender",
   *   "conversationId": "uuid-of-conversation"
   * }
   *
   * With WhatsApp template:
   * {
   *   "body": "Template message",
   *   "senderId": "uuid-of-whatsapp-sender",
   *   "contactId": "uuid-of-contact",
   *   "templateId": "template_123",
   *   "templateName": "welcome_message"
   * }
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async sendMessage(
    @WorkspaceId() workspaceId: string,
    @Body() dto: CreateMessageDto,
  ) {
    const message = await this.communicationService.sendMessageWithSender(
      workspaceId,
      dto.senderId,
      dto.body,
      {
        conversationId: dto.conversationId,
        contactId: dto.contactId,
        templateId: dto.templateId,
        templateName: dto.templateName,
      },
    );
    return { data: message };
  }
}
