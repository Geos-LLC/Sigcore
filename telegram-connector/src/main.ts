import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bodyParser: true,
  });

  app.enableCors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    credentials: true,
  });

  const port = Number(process.env.PORT) || 3003;
  await app.listen(port);
  Logger.log(`Sigcore Telegram connector listening on port ${port}`, 'Bootstrap');
}

bootstrap().catch(err => {
  Logger.error(`Failed to start Telegram connector: ${err?.message ?? err}`, 'Bootstrap');
  process.exit(1);
});