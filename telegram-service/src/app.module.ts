import { Module } from '@nestjs/common';
import { TelegramController } from './telegram.controller';
import { WebhooksController } from './webhooks.controller';
import { TelegramService } from './telegram.service';
import { TeleporterClient } from './teleporter-client.service';
import { VerifyCache } from './verify-cache.service';
import { SigcoreCallbackClient } from './sigcore-callback-client.service';

@Module({
  controllers: [TelegramController, WebhooksController],
  providers: [TelegramService, TeleporterClient, VerifyCache, SigcoreCallbackClient],
})
export class AppModule {}
