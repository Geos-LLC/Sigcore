import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { SigcoreAuthGuard } from '../auth/sigcore-auth.guard';
import { CommunicationService } from '../communication/communication.service';

interface ApiRequest {
  workspaceId: string;
  tenantId?: string;
  apiKeyScope?: string;
}

@Controller('v1')
@UseGuards(SigcoreAuthGuard)
export class ApiController {
  constructor(
    private readonly communicationService: CommunicationService,
  ) {}

  // ==================== CONVERSATIONS ====================

  @Get('conversations')
  async getConversations(
    @Request() req: ApiRequest,
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

    const result = await this.communicationService.getConversations(req.workspaceId, {
      page: pageNum,
      limit: limitNum,
      search,
      phoneNumberId,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      provider: provider as 'openphone' | 'twilio' | undefined,
    });

    return {
      success: true,
      data: result.conversations,
      meta: result.meta,
    };
  }

  @Get('conversations/:id')
  async getConversation(
    @Request() req: ApiRequest,
    @Param('id') conversationId: string,
  ) {
    const messages = await this.communicationService.getMessagesForConversation(
      req.workspaceId,
      conversationId,
    );

    return {
      success: true,
      data: {
        id: conversationId,
        messages,
      },
    };
  }

  @Get('conversations/:id/messages')
  async getConversationMessages(
    @Request() req: ApiRequest,
    @Param('id') conversationId: string,
  ) {
    const messages = await this.communicationService.getMessagesForConversation(
      req.workspaceId,
      conversationId,
    );

    return {
      success: true,
      data: messages,
    };
  }

  @Post('conversations/:id/messages')
  @HttpCode(HttpStatus.CREATED)
  async sendMessage(
    @Request() req: ApiRequest,
    @Param('id') conversationId: string,
    @Body() dto: { body: string; fromNumber: string },
  ) {
    const message = await this.communicationService.sendMessageToConversation(
      req.workspaceId,
      conversationId,
      dto.body,
      dto.fromNumber,
    );

    return {
      success: true,
      data: message,
    };
  }

  @Get('conversations/:id/calls')
  async getConversationCalls(
    @Request() req: ApiRequest,
    @Param('id') conversationId: string,
  ) {
    const calls = await this.communicationService.getCallsForConversation(
      req.workspaceId,
      conversationId,
    );

    return {
      success: true,
      data: calls,
    };
  }

  // ==================== MESSAGES ====================

  /**
   * Send a message directly to a phone number.
   * This is the preferred endpoint for multi-channel messaging.
   * If no existing conversation exists, one will be created.
   */
  @Post('messages')
  @HttpCode(HttpStatus.CREATED)
  async sendMessageToPhoneNumber(
    @Request() req: ApiRequest,
    @Body() dto: {
      fromNumber: string;
      toNumber: string;
      body: string;
      channel?: string;
    },
  ) {
    const message = await this.communicationService.sendMessageToPhoneNumber(
      req.workspaceId,
      dto.fromNumber,
      dto.toNumber,
      dto.body,
      dto.channel || 'sms',
      req.tenantId,
    );

    return {
      success: true,
      data: message,
    };
  }

  // ==================== PHONE NUMBERS ====================

  @Get('phone-numbers')
  async getPhoneNumbers(@Request() req: ApiRequest) {
    const phoneNumbers = await this.communicationService.getPhoneNumbers(req.workspaceId);

    return {
      success: true,
      data: phoneNumbers,
    };
  }

  // ==================== DEBUG ====================

  /**
   * Returns the identity of the calling API key.
   * GET /api/v1/whoami
   */
  @Get('whoami')
  async whoami(@Request() req: ApiRequest) {
    return {
      workspaceId: req.workspaceId,
      tenantId: req.tenantId || null,
      apiKeyScope: req.apiKeyScope || 'workspace',
    };
  }
}
