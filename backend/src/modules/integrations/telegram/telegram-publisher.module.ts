import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { TelegramSubscriber } from '../../../database/entities/telegram-subscriber.entity';
import { TelegramPlacement } from '../../../database/entities/telegram-placement.entity';
import { ApiKey } from '../../../database/entities/api-key.entity';
import { SigcoreAuthModule } from '../../auth/sigcore-auth.module';
import { WebhooksModule } from '../../webhooks/webhooks.module';
import { TelegramPublisherController } from './telegram-publisher.controller';
import { TelegramEventCallbackController } from './telegram-event-callback.controller';
import { TelegramPublisherService } from './telegram-publisher.service';
import { TelegramServiceClient } from './telegram-service.client';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([TelegramSubscriber, TelegramPlacement, ApiKey]),
    SigcoreAuthModule,
    forwardRef(() => WebhooksModule),
  ],
  controllers: [TelegramPublisherController, TelegramEventCallbackController],
  providers: [TelegramPublisherService, TelegramServiceClient],
  exports: [TelegramPublisherService],
})
export class TelegramPublisherModule {}
