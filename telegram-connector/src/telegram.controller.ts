import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AccountStoreService } from './accounts/account-store.service';
import { TelegramService } from './telegram.service';
import { WebhookRateLimitGuard } from './security/webhook-rate-limit.guard';
import { redact } from './common/redact';

@Controller()
export class TelegramController {
  private readonly logger = new Logger(TelegramController.name);

  constructor(
    private readonly tg: TelegramService,
    private readonly accounts: AccountStoreService,
  ) {}

  @Get('health')
  health() {
    return { ok: true, service: 'telegram-connector', timestamp: new Date().toISOString() };
  }

  // -------- Account lifecycle --------

  @Post('telegram/accounts/connect')
  async connect(
    @Headers('x-api-key') apiKey: string,
    @Body() body: {
      tenantId: string;
      mode: 'bot' | 'mtproto';
      displayName?: string;
      botUsername?: string;
      botToken?: string;
      telegramUserId?: string;
      phone?: string;
      gramjsSession?: string;
    },
  ) {
    this.tg.requireApiKey(apiKey);
    if (!body?.tenantId || !body?.mode) {
      throw new BadRequestException('tenantId and mode required');
    }
    this.logger.log(`[accounts/connect] tenant=${body.tenantId} mode=${body.mode}`);

    if (body.mode === 'bot') {
      if (!body.botToken) throw new BadRequestException('botToken required for mode=bot');
      const acct = await this.accounts.registerBot({
        tenantId: body.tenantId,
        botToken: body.botToken,
        displayName: body.displayName,
        botUsername: body.botUsername,
      });
      return { id: acct.id, status: acct.status };
    }

    if (body.mode === 'mtproto') {
      if (!body.gramjsSession) throw new BadRequestException('gramjsSession required for mode=mtproto');
      try {
        const acct = await this.accounts.registerMtproto({
          tenantId: body.tenantId,
          gramjsSession: body.gramjsSession,
          telegramUserId: body.telegramUserId,
          phone: body.phone,
          displayName: body.displayName,
        });
        return { id: acct.id, status: acct.status };
      } catch (e: any) {
        if (e?.message === 'mtproto_disabled') {
          throw new BadRequestException({ error: 'mtproto_disabled' });
        }
        throw e;
      }
    }

    throw new BadRequestException('unknown mode');
  }

  @Get('telegram/accounts/status')
  async status(
    @Headers('x-api-key') apiKey: string,
    @Query('tenantId') tenantId: string,
    @Query('accountId') accountId: string,
  ) {
    this.tg.requireApiKey(apiKey);
    if (!tenantId || !accountId) throw new BadRequestException('tenantId, accountId required');
    return this.tg.getAccountStatus(tenantId, accountId);
  }

  @Get('telegram/accounts')
  async list(@Headers('x-api-key') apiKey: string, @Query('tenantId') tenantId: string) {
    this.tg.requireApiKey(apiKey);
    if (!tenantId) throw new BadRequestException('tenantId required');
    const rows = await this.accounts.listForTenant(tenantId);
    return rows.map(r => ({
      id: r.id,
      mode: r.mode,
      displayName: r.displayName,
      botUsername: r.botUsername,
      status: r.status,
      lastConnectedAt: r.lastConnectedAt,
      lastPingAt: r.lastPingAt,
    }));
  }

  // -------- Outbound --------

  @Post('telegram/messages/send')
  async send(
    @Headers('x-api-key') apiKey: string,
    @Body() body: {
      tenantId: string;
      accountId: string;
      telegramChatId: string;
      text: string;
      conversationId?: string;
      idempotencyKey?: string;
    },
  ) {
    this.tg.requireApiKey(apiKey);
    if (!body?.tenantId || !body?.accountId || !body?.telegramChatId || !body?.text) {
      throw new BadRequestException('tenantId, accountId, telegramChatId, text required');
    }
    this.logger.log(`[messages/send] ${JSON.stringify(redact({ ...body, text: '[len ' + body.text.length + ']' }))}`);
    return this.tg.send(body);
  }

  // -------- Inbound webhook (Telegram → connector) --------

  @Post('telegram/webhook/:tenantId/:accountId')
  @HttpCode(HttpStatus.OK)
  @UseGuards(WebhookRateLimitGuard)
  async webhook(
    @Param('tenantId') tenantId: string,
    @Param('accountId') accountId: string,
    @Headers('x-telegram-bot-api-secret-token') secretToken: string,
    @Body() update: any,
  ) {
    this.tg.verifyWebhookSecret(secretToken);
    return this.tg.receiveWebhook(tenantId, accountId, update);
  }
}
