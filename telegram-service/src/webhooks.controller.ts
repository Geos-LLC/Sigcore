import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import * as crypto from 'crypto';
import { SigcoreCallbackClient } from './sigcore-callback-client.service';

interface TeleporterCallbackPayload {
  event:
    | 'message.sent'
    | 'message.failed'
    | 'account.linked'
    | 'account.revoked';
  subscriberWorkspaceId: string;
  // Message events
  messageId?: string;
  providerMessageId?: string;
  errorCode?: string;
  errorMessage?: string;
  // Account events
  accountId?: string;
  tgUserId?: string;
  tgUsername?: string;
  reason?: string;
  occurredAt?: string;
  data?: Record<string, unknown>;
}

@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(private readonly callback: SigcoreCallbackClient) {}

  /**
   * TelePorter → telegram-service callback. Verified via HMAC-SHA256 of
   * the raw body with TELEPORTER_CALLBACK_HMAC_SECRET (per-integrator
   * callback secret issued by TelePorter at registration — distinct
   * from TELEPORTER_SERVICE_KEY which is the outbound auth header).
   *
   * NOTE: main.ts mounts express.raw() on this path so req.body is a
   * Buffer of the unparsed JSON. We parse here AFTER verifying.
   */
  @Post('teleporter')
  @HttpCode(HttpStatus.OK)
  async handleTeleporterCallback(
    @Req() req: Request,
    @Headers('x-teleporter-signature') signature: string,
  ) {
    const secret =
      process.env.TELEPORTER_CALLBACK_HMAC_SECRET || process.env.TELEPORTER_SERVICE_KEY;
    if (!secret) {
      this.logger.error(
        'TELEPORTER_CALLBACK_HMAC_SECRET not set — refusing callback',
      );
      throw new HttpException('Service misconfigured', HttpStatus.SERVICE_UNAVAILABLE);
    }
    if (!signature) {
      throw new HttpException('Missing signature', HttpStatus.UNAUTHORIZED);
    }

    const raw: Buffer = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));

    if (!this.verifySignature(raw, signature, secret)) {
      throw new HttpException('Invalid signature', HttpStatus.UNAUTHORIZED);
    }

    let payload: TeleporterCallbackPayload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new HttpException('Invalid JSON body', HttpStatus.BAD_REQUEST);
    }

    const SUPPORTED = new Set([
      'message.sent',
      'message.failed',
      'account.linked',
      'account.revoked',
    ]);
    if (!SUPPORTED.has(payload.event)) {
      this.logger.log(`Ignoring TelePorter event ${payload.event}`);
      return { received: true, ignored: 'unsupported_event' };
    }
    if (!payload.subscriberWorkspaceId) {
      throw new HttpException('Missing subscriberWorkspaceId', HttpStatus.BAD_REQUEST);
    }

    const isMessageEvent =
      payload.event === 'message.sent' || payload.event === 'message.failed';
    if (isMessageEvent && !payload.messageId) {
      throw new HttpException('Missing messageId on message event', HttpStatus.BAD_REQUEST);
    }

    const eventTypeMap = {
      'message.sent': 'placement.sent',
      'message.failed': 'placement.failed',
      'account.linked': 'account.linked',
      'account.revoked': 'account.revoked',
    } as const;
    const normalizedEventType = eventTypeMap[payload.event];

    const dataForEvent = isMessageEvent
      ? {
          messageId: payload.messageId,
          providerMessageId: payload.providerMessageId,
          errorCode: payload.errorCode,
          errorMessage: payload.errorMessage,
          ...(payload.data || {}),
        }
      : {
          accountId: payload.accountId,
          tgUserId: payload.tgUserId,
          tgUsername: payload.tgUsername,
          reason: payload.reason,
          ...(payload.data || {}),
        };

    await this.callback.forwardEvent({
      workspaceId: payload.subscriberWorkspaceId,
      eventType: normalizedEventType,
      timestamp: payload.occurredAt || new Date().toISOString(),
      data: dataForEvent,
    });

    return { received: true };
  }

  private verifySignature(rawBody: Buffer, headerValue: string, secret: string): boolean {
    // Accept both 'sha256=<hex>' and bare '<hex>' shapes — defensive.
    const provided = headerValue.startsWith('sha256=') ? headerValue.slice(7) : headerValue;
    const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    try {
      const a = Buffer.from(provided, 'hex');
      const b = Buffer.from(computed, 'hex');
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  /**
   * Body accepted via @Body just to ensure NestJS validates the route
   * exists in dev tooling — we never use this value because the rawBody
   * is what we verify against the HMAC.
   */
  @Post('teleporter/diagnostic')
  @HttpCode(HttpStatus.OK)
  diagnostic(@Body() _: unknown) {
    return { ok: true };
  }
}
