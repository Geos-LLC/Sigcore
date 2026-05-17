import { Module } from '@nestjs/common';
import { AccountStoreService } from './account-store.service';
import { DedupeService } from './dedupe.service';
import { DrainerService } from './drainer.service';
import { EncryptionService } from './encryption.service';
import { EventBusService } from './event-bus.service';
import { InboundEventsStore } from './inbound-events.store';
import { SigcoreIngestService } from './sigcore-ingest.service';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';
import { TransportFactory } from './transports/transport.factory';

@Module({
  controllers: [TelegramController],
  providers: [
    EncryptionService,
    AccountStoreService,
    DedupeService,
    InboundEventsStore,
    SigcoreIngestService,
    EventBusService,
    TransportFactory,
    DrainerService,
    TelegramService,
  ],
})
export class AppModule {}
