import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';
import { EncryptionService } from './common/encryption.service';
import { AccountStoreService } from './accounts/account-store.service';
import { TelegramAccount } from './accounts/telegram-account.entity';
import { TelegramInboundEvent } from './inbound/telegram-inbound-event.entity';
import { TelegramOutboundIdempotency } from './outbound/outbound-idempotency.entity';
import { DurableEventStoreService } from './inbound/durable-event-store.service';
import { DrainerService } from './inbound/drainer.service';
import { OutboundService } from './outbound/outbound.service';
import { OutboundIdempotencyService } from './outbound/outbound-idempotency.service';
import { SigcoreIngestService } from './events/sigcore-ingest.service';
import { BotTransport } from './transport/bot.transport';
import { MTProtoTransport } from './transport/mtproto.transport';
import { TransportFactory } from './transport/transport.factory';
import { WebhookRateLimitGuard } from './security/webhook-rate-limit.guard';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: process.env.DATABASE_URL,
      entities: [TelegramAccount, TelegramInboundEvent, TelegramOutboundIdempotency],
      synchronize: process.env.NODE_ENV !== 'production',
      logging: false,
    }),
    TypeOrmModule.forFeature([TelegramAccount, TelegramInboundEvent, TelegramOutboundIdempotency]),
  ],
  controllers: [TelegramController],
  providers: [
    TelegramService,
    EncryptionService,
    AccountStoreService,
    DurableEventStoreService,
    DrainerService,
    OutboundService,
    OutboundIdempotencyService,
    SigcoreIngestService,
    BotTransport,
    MTProtoTransport,
    TransportFactory,
    WebhookRateLimitGuard,
  ],
})
export class AppModule {}
