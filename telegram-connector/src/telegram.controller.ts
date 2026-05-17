import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { WebhookRateLimitGuard } from './rate-limit.guard';
import { SendMessageRequest, TelegramBotUpdate } from './types';

@Controller('api')
export class TelegramController {
  constructor(private readonly telegram: TelegramService) {}

  private requireServiceAuth(apiKey: string | undefined): void {
    const expected = process.env.SERVICE_API_KEY;
    if (!expected) {
      // Fail closed in production: never serve mutating routes without auth.
      throw new UnauthorizedException('service_auth_not_configured');
    }
    if (apiKey !== expected) {
      throw new UnauthorizedException('invalid_api_key');
    }
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------
  @Get('health')
  health() {
    return { status: 'ok', service: 'sigcore-telegram-connector', version: '0.1.0' };
  }

  // -------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------
  @Post('telegram/accounts/connect')
  async connectAccount(
    @Headers('x-api-key') apiKey: string,
    @Body() body: {
      tenantId: string;
      mode: 'bot' | 'mtproto';
      displayName: string;
      botToken?: string;
      gramjsSession?: string;
      phone?: string;
    },
  ) {
    this.requireServiceAuth(apiKey);
    if (!body?.tenantId || !body?.mode || !body?.displayName) {
      throw new BadRequestException('tenantId, mode, and displayName are required');
    }
    const account = await this.telegram.connectAccount(body);
    return { ok: true, account };
  }

  @Get('telegram/accounts/status')
  getAccountStatus(
    @Headers('x-api-key') apiKey: string,
    @Query('tenantId') tenantId: string,
    @Query('accountId') accountId: string,
  ) {
    this.requireServiceAuth(apiKey);
    if (!tenantId || !accountId) {
      throw new BadRequestException('tenantId and accountId are required');
    }
    const account = this.telegram.getAccountStatus(tenantId, accountId);
    return { ok: true, account };
  }

  @Get('telegram/accounts')
  listAccounts(
    @Headers('x-api-key') apiKey: string,
    @Query('tenantId') tenantId: string,
  ) {
    this.requireServiceAuth(apiKey);
    if (!tenantId) throw new BadRequestException('tenantId required');
    return { ok: true, accounts: this.telegram.listAccounts(tenantId) };
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------
  @Post('telegram/messages/send')
  async sendMessage(
    @Headers('x-api-key') apiKey: string,
    @Body() body: SendMessageRequest,
  ) {
    this.requireServiceAuth(apiKey);
    return this.telegram.sendMessage(body);
  }

  // -------------------------------------------------------------------------
  // Inbound webhook — public-ish endpoint, rate-limited.
  // Auth: Telegram includes the X-Telegram-Bot-Api-Secret-Token header we set
  //       at setWebhook time. We also require tenant/account routing via path
  //       params so a leaked URL can't bridge tenants.
  // -------------------------------------------------------------------------
  @Post('telegram/webhook/:tenantId/:accountId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(WebhookRateLimitGuard)
  async webhook(
    @Param('tenantId') tenantId: string,
    @Param('accountId') accountId: string,
    @Headers('x-telegram-bot-api-secret-token') telegramSecret: string,
    @Body() update: TelegramBotUpdate,
  ) {
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (expectedSecret && telegramSecret !== expectedSecret) {
      throw new UnauthorizedException('invalid_telegram_secret');
    }
    if (!tenantId || !accountId) {
      throw new BadRequestException('tenant_and_account_required');
    }

    // Validate routing — reject updates targeting unknown accounts.
    try {
      this.telegram.getAccountStatus(tenantId, accountId);
    } catch {
      throw new HttpException('unknown_account', HttpStatus.NOT_FOUND);
    }

    const result = await this.telegram.handleInbound(update, { tenantId, accountId });
    return { ok: result.ok, deduped: result.deduped, forwarded: result.forwarded };
  }
}