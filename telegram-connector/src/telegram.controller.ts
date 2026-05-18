import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { TelegramUpdate } from './inbound/normalizer';
import { WebhookRateLimitGuard } from './security/webhook-rate-limit.guard';
import { mtprotoEnabled } from './transport/mtproto.transport';

interface ConnectBody {
  tenantId: string;
  mode: 'bot' | 'mtproto';
  displayName?: string;
  botToken?: string;
  botUsername?: string;
  gramjsSession?: string;
  telegramUserId?: string;
  phone?: string;
}

interface SendBody {
  tenantId: string;
  accountId: string;
  telegramChatId: string;
  text: string;
  conversationId?: string;
  idempotencyKey?: string;
}

@Controller()
export class TelegramController {
  constructor(private readonly telegram: TelegramService) {}

  // ===== Health =====================================================
  @Get('health')
  health() {
    return {
      status: 'ok',
      service: 'sigcore-telegram-connector',
      mtprotoEnabled: mtprotoEnabled(),
    };
  }

  // ===== Account control endpoints (internal x-api-key) =============
  @Post('telegram/accounts/connect')
  async connect(
    @Headers('x-api-key') apiKey: string,
    @Body() body: ConnectBody,
  ) {
    this.assertInternalAuth(apiKey);
    if (!body?.tenantId) throw new BadRequestException('tenantId_required');
    if (!body?.mode) throw new BadRequestException('mode_required');

    try {
      const acct = await this.telegram.connectAccount({
        tenantId: body.tenantId,
        mode: body.mode,
        displayName: body.displayName || '',
        botToken: body.botToken,
        botUsername: body.botUsername,
        gramjsSession: body.gramjsSession,
        telegramUserId: body.telegramUserId,
        phone: body.phone,
      });
      return { ok: true, account: acct };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown_error';
      const status = msg === 'mtproto_disabled' ? HttpStatus.FORBIDDEN : HttpStatus.BAD_REQUEST;
      throw new HttpException({ ok: false, error: msg }, status);
    }
  }

  @Get('telegram/accounts/status')
  async status(
    @Headers('x-api-key') apiKey: string,
    @Headers('x-tenant-id') tenantId: string,
    @Headers('x-account-id') accountId: string,
  ) {
    this.assertInternalAuth(apiKey);
    if (!tenantId || !accountId) {
      throw new BadRequestException('tenant_and_account_required');
    }
    const acct = await this.telegram.getAccountStatus(tenantId, accountId);
    if (!acct) throw new HttpException({ ok: false, error: 'telegram_account_not_found' }, HttpStatus.NOT_FOUND);
    return { ok: true, account: acct };
  }

  @Get('telegram/accounts')
  async list(
    @Headers('x-api-key') apiKey: string,
    @Headers('x-tenant-id') tenantId: string,
  ) {
    this.assertInternalAuth(apiKey);
    if (!tenantId) throw new BadRequestException('tenant_required');
    return { ok: true, accounts: await this.telegram.listAccounts(tenantId) };
  }

  @Delete('telegram/accounts/:accountId')
  async disconnect(
    @Headers('x-api-key') apiKey: string,
    @Headers('x-tenant-id') tenantId: string,
    @Param('accountId') accountId: string,
  ) {
    this.assertInternalAuth(apiKey);
    if (!tenantId) throw new BadRequestException('tenant_required');
    const ok = await this.telegram.disconnectAccount(tenantId, accountId);
    return { ok };
  }

  // ===== Outbound (internal x-api-key) ==============================
  @Post('telegram/messages/send')
  async send(
    @Headers('x-api-key') apiKey: string,
    @Body() body: SendBody,
  ) {
    this.assertInternalAuth(apiKey);
    const result = await this.telegram.send(body);
    return result;
  }

  // ===== Dead-letter inspection =====================================
  @Get('telegram/events/dead')
  async dead(
    @Headers('x-api-key') apiKey: string,
    @Headers('x-tenant-id') tenantId: string,
  ) {
    this.assertInternalAuth(apiKey);
    if (!tenantId) throw new BadRequestException('tenant_required');
    return { events: await this.telegram.listDeadEvents(tenantId) };
  }

  // ===== Public Telegram webhook ====================================
  /**
   * Webhook is mounted *under a tenant- and account-scoped path* so Telegram
   * itself can't be coaxed into routing into the wrong tenancy.  Optional
   * Telegram secret-token header gives a second factor when configured.
   */
  @Post('telegram/webhook/:tenantId/:accountId')
  @UseGuards(WebhookRateLimitGuard)
  @HttpCode(HttpStatus.OK)
  async webhook(
    @Param('tenantId') tenantId: string,
    @Param('accountId') accountId: string,
    @Headers('x-telegram-bot-api-secret-token') secretToken: string,
    @Body() update: TelegramUpdate,
  ) {
    this.assertWebhookSecret(secretToken);
    const result = await this.telegram.ingestUpdate(tenantId, accountId, update);
    return { ok: true, ...result };
  }

  // ===== Auth helpers ===============================================
  private assertInternalAuth(apiKey: string): void {
    const expected = process.env.TELEGRAM_CONNECTOR_API_KEY;
    if (!expected) return; // unset in dev — explicit, not hidden
    if (apiKey !== expected) {
      throw new UnauthorizedException('invalid_api_key');
    }
  }

  private assertWebhookSecret(token: string): void {
    const expected = process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN;
    if (!expected) return; // not configured — tenant path is the only check
    if (token !== expected) {
      throw new UnauthorizedException('invalid_webhook_secret_token');
    }
  }
}
