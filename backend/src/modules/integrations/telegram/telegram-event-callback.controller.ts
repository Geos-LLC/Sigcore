import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { TelegramPublisherService } from './telegram-publisher.service';

interface CallbackBody {
  workspaceId: string;
  eventType:
    | 'placement.sent'
    | 'placement.failed'
    | 'account.linked'
    | 'account.revoked';
  timestamp: string;
  data: Record<string, unknown>;
}

const SUPPORTED_EVENTS = new Set<CallbackBody['eventType']>([
  'placement.sent',
  'placement.failed',
  'account.linked',
  'account.revoked',
]);

/**
 * Internal endpoint — called only by telegram-service.
 * Auth: x-webhook-key header must match SIGCORE_WEBHOOK_KEY env var.
 * (Same shape as /webhooks/whatsapp/inbound — see plan §3 for rationale.)
 */
@Controller('internal/telegram')
export class TelegramEventCallbackController {
  private readonly logger = new Logger(TelegramEventCallbackController.name);

  constructor(private readonly service: TelegramPublisherService) {}

  @Post('event')
  @HttpCode(HttpStatus.OK)
  async handleEvent(
    @Headers('x-webhook-key') webhookKey: string,
    @Body() body: CallbackBody,
  ) {
    const expected = process.env.SIGCORE_WEBHOOK_KEY;
    if (!expected) {
      this.logger.error('SIGCORE_WEBHOOK_KEY not set');
      throw new ServiceUnavailableException('Service misconfigured');
    }
    if (webhookKey !== expected) {
      throw new UnauthorizedException('Invalid webhook key');
    }
    if (!body?.workspaceId || !body?.eventType || !body?.data) {
      throw new BadRequestException('Missing required fields');
    }
    if (!SUPPORTED_EVENTS.has(body.eventType)) {
      throw new BadRequestException(`Unsupported eventType '${body.eventType}'`);
    }

    await this.service.handleProviderEvent(body);
    return { received: true };
  }
}
