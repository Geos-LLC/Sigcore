import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { SigcoreAuthModule } from './modules/auth/sigcore-auth.module';
import { CommunicationModule } from './modules/communication/communication.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { EventsModule } from './modules/events/events.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { ApiModule } from './modules/api/api.module';
import { EmailModule } from './modules/email/email.module';
import { HealthController } from './health.controller';
import { DocsController } from './docs.controller';
import { BootstrapController } from './bootstrap.controller';
import { Workspace } from './database/entities/workspace.entity';
import { ApiKey } from './database/entities/api-key.entity';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    EventEmitterModule.forRoot(),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        const isProduction = configService.get('NODE_ENV') === 'production';
        const syncDb = configService.get('SYNC_DATABASE') === 'true';
        console.log(`Database sync enabled: ${syncDb} (NODE_ENV=${configService.get('NODE_ENV')}, isProduction=${isProduction})`);
        return {
          type: 'postgres',
          url: configService.get('DATABASE_URL'),
          entities: [__dirname + '/database/entities/*.entity{.ts,.js}'],
          migrations: [__dirname + '/database/migrations/*{.ts,.js}'],
          synchronize: syncDb,
          migrationsRun: isProduction,
          ssl: isProduction
            ? { rejectUnauthorized: false }
            : false,
          logging: !isProduction,
        };
      },
      inject: [ConfigService],
    }),
    TypeOrmModule.forFeature([Workspace, ApiKey]),
    SigcoreAuthModule,
    CommunicationModule,
    IntegrationsModule,
    WebhooksModule,
    EventsModule,
    TenantsModule,
    ApiModule,
    EmailModule,
  ],
  controllers: [HealthController, DocsController, BootstrapController],
})
export class AppModule {}
