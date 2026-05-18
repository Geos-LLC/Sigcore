import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: true });
  app.setGlobalPrefix('api');
  const port = Number(process.env.PORT || 4002);
  await app.listen(port);
  new Logger('Bootstrap').log(`telegram-connector listening on :${port}`);
}
bootstrap();
