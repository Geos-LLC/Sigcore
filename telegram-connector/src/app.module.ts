import { Module } from '@nestjs/common';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';
import { AccountStoreService } from './accounts/account-store.service';
import { EncryptionService } from './common/encryption.service';
import { DurableEventStoreService } from './inbound/durable-event-store.service';
import { DrainerService } from './inbound/drainer.service';
import { SigcoreIngestService } from './events/sigcore-ingest.service';
import { OutboundService } from './outbound/outbound.service';
import { BotTransport } from './transport/bot.transport';
import { MTProtoTransport } from './transport/mtproto.transport';
import { TransportFactory } from './transport/transport.factory';
import { WebhookRateLimitGuard } from './security/webhook-rate-limit.guard';

@Module({
  controllers: [TelegramController],
  providers: [
    EncryptionService,
    AccountStoreService,
    DurableEventStoreService,
    SigcoreIngestService,
    BotTransport,
    MTProtoTransport,
    TransportFactory,
    OutboundService,
    DrainerService,
    TelegramService,
    WebhookRateLimitGuard,
  ],
})
export class AppModule {}
