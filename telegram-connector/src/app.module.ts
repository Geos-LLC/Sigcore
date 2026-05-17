import { Module } from '@nestjs/common';
import { AccountStoreService } from './account-store.service';
import { DedupeService } from './dedupe.service';
import { EncryptionService } from './encryption.service';
import { SigcoreIngestService } from './sigcore-ingest.service';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';

@Module({
  controllers: [TelegramController],
  providers: [
    EncryptionService,
    AccountStoreService,
    DedupeService,
    SigcoreIngestService,
    TelegramService,
  ],
})
export class AppModule {}