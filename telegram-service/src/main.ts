import { NestFactory } from '@nestjs/core';
import { json, raw } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  // HMAC verify on /webhooks/teleporter needs the raw bytes. Mount raw()
  // first for that route, then JSON for everything else.
  app.use('/webhooks/teleporter', raw({ type: 'application/json', limit: '2mb' }));
  app.use(json({ limit: '2mb' }));

  app.enableCors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    credentials: true,
  });

  const port = process.env.PORT || 3002;
  await app.listen(port);
  console.log(`Sigcore Telegram service running on port ${port}`);
}

bootstrap();
