import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpException,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { TelegramService } from './telegram.service';

@Controller()
export class TelegramController {
  constructor(private readonly telegram: TelegramService) {}

  @Get('health')
  health() {
    return { status: 'ok', service: 'sigcore-telegram' };
  }

  @Post('subscribers')
  async createSubscriber(
    @Headers('x-api-key') apiKey: string,
    @Body() body: { workspaceId: string; displayName?: string },
  ) {
    this.validateApiKey(apiKey);
    if (!body?.workspaceId) {
      throw new HttpException('workspaceId required', HttpStatus.BAD_REQUEST);
    }
    return this.telegram.provisionSubscriber(body.workspaceId, body.displayName);
  }

  @Get('subscribers/:workspaceId')
  async getSubscriber(
    @Headers('x-api-key') apiKey: string,
    @Param('workspaceId') workspaceId: string,
  ) {
    this.validateApiKey(apiKey);
    return this.telegram.getSubscriber(workspaceId);
  }

  @Delete('subscribers/:workspaceId')
  async deleteSubscriber(
    @Headers('x-api-key') apiKey: string,
    @Param('workspaceId') workspaceId: string,
  ) {
    this.validateApiKey(apiKey);
    await this.telegram.deleteSubscriber(workspaceId);
    return { success: true };
  }

  @Post('verify-chat')
  async verifyChat(
    @Headers('x-api-key') apiKey: string,
    @Body() body: { workspaceId: string; chatRef: string; probe?: boolean },
  ) {
    this.validateApiKey(apiKey);
    if (!body?.workspaceId || !body?.chatRef) {
      throw new HttpException('workspaceId and chatRef required', HttpStatus.BAD_REQUEST);
    }
    return this.telegram.verifyChat(body);
  }

  @Post('publish')
  async publish(
    @Headers('x-api-key') apiKey: string,
    @Body() body: {
      workspaceId: string;
      chatRef: string;
      text?: string;
      parseMode?: 'Markdown' | 'HTML' | null;
      imageUrl?: string;
      scheduledAt?: string;
      idempotencyKey: string;
    },
  ) {
    this.validateApiKey(apiKey);
    if (!body?.workspaceId || !body?.chatRef || !body?.idempotencyKey) {
      throw new HttpException(
        'workspaceId, chatRef, idempotencyKey required',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!body.text && !body.imageUrl) {
      throw new HttpException(
        'at least one of text or imageUrl required',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.telegram.publish(body);
  }

  @Post('messages/:id/cancel')
  async cancel(
    @Headers('x-api-key') apiKey: string,
    @Param('id') id: string,
  ) {
    this.validateApiKey(apiKey);
    return this.telegram.cancel(id);
  }

  private validateApiKey(apiKey: string | undefined): void {
    const expected = process.env.SERVICE_API_KEY;
    if (expected && apiKey !== expected) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }
  }
}
