import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
    credentials: true,
  });

  app.setGlobalPrefix('api');

  const port = process.env.PORT || 3002;
  await app.listen(port);
  console.log(`Sigcore Telegram connector running on port ${port}`);
}

bootstrap();
