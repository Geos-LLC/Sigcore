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
import { InboundEventsStore } from './inbound-events.store';

@Controller('api')
export class TelegramController {
  constructor(
    private readonly telegram: TelegramService,
    private readonly inboundStore: InboundEventsStore,
  ) {}

  private requireServiceAuth(apiKey: string | undefined): void {
    const expected = process.env.SERVICE_API_KEY;
    if (!expected) {
      // Fail closed: never serve mutating routes without auth.
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
    return {
      status: 'ok',
      service: 'sigcore-telegram-connector',
      version: '0.2.0',
      events: this.inboundStore.countByStatus(),
    };
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

  @Post('telegram/accounts/:accountId/disconnect')
  async disconnectAccount(
    @Headers('x-api-key') apiKey: string,
    @Param('accountId') accountId: string,
    @Body() body: { tenantId: string },
  ) {
    this.requireServiceAuth(apiKey);
    if (!body?.tenantId) throw new BadRequestException('tenantId required');
    await this.telegram.disconnectAccount(body.tenantId, accountId);
    return { ok: true };
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
  // Operator: list dead-lettered events for a tenant
  // -------------------------------------------------------------------------
  @Get('telegram/events/dead')
  listDead(
    @Headers('x-api-key') apiKey: string,
    @Query('tenantId') tenantId: string,
  ) {
    this.requireServiceAuth(apiKey);
    if (!tenantId) throw new BadRequestException('tenantId required');
    return { ok: true, events: this.inboundStore.listDead(tenantId) };
  }

  // -------------------------------------------------------------------------
  // Inbound webhook — public-ish endpoint, rate-limited.
  // Auth: Telegram includes X-Telegram-Bot-Api-Secret-Token (we set this at
  //       setWebhook time). Tenant/account routing is in the URL path so a
  //       leaked URL can't bridge tenants.
  //
  // The handler enqueues the event durably and returns 200. Drainer takes
  // over from here — failure to forward to Sigcore is retried out-of-band.
  // -------------------------------------------------------------------------
  @Post('telegram/webhook/:tenantId/:accountId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(WebhookRateLimitGuard)
  webhook(
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

    const result = this.telegram.handleInbound(update, { tenantId, accountId });
    return { ok: result.ok, deduped: result.deduped, enqueued: result.enqueued, eventId: result.eventId };
  }
}
