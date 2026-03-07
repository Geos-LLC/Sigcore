import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    rawBody: true, // Needed for webhook signature verification
  });

  // Trust Railway's reverse proxy so req.protocol reflects the real scheme (https).
  // Without this, Twilio signature validation fails because req.protocol returns 'http'
  // while Twilio signed the webhook URL with 'https'.
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.set('trust proxy', 1);

  const configService = app.get(ConfigService);
  const logger = new Logger('HTTP');

  // Enable CORS FIRST — must run before any other middleware
  // so preflight OPTIONS requests get CORS headers immediately.
  const callioBackendUrl = configService.get('CALLIO_BACKEND_URL') || 'http://localhost:3001';
  const frontendUrl = configService.get('FRONTEND_URL'); // optional custom domain e.g. https://www.sigcore.org
  app.enableCors({
    origin: [
      'http://localhost:3001',
      'http://localhost:3000',
      callioBackendUrl,
      /\.railway\.app$/,
      /\.vercel\.app$/,
      /sigcore\.org$/,
      ...(frontendUrl ? [frontendUrl] : []),
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With', 'X-API-Key', 'x-api-key', 'x-sigcore-key', 'x-workspace-id'],
    exposedHeaders: ['Content-Length', 'X-Request-Id'],
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });

  // Ensure all API responses have Content-Type: application/json
  app.use('/api', (req: any, res: any, next: () => void) => {
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      if (!res.getHeader('content-type')) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
      return originalJson(body);
    };
    next();
  });

  // Request/Response logging middleware
  app.use((req: { method: string; originalUrl: string; body: unknown }, res: { statusCode: number; on: (event: string, cb: () => void) => void }, next: () => void) => {
    const startTime = Date.now();
    logger.log(`[Request] ${req.method} ${req.originalUrl}`);
    if (req.body && Object.keys(req.body).length > 0) {
      logger.log(`[Request Body] ${JSON.stringify(req.body)}`);
    }

    res.on('finish', () => {
      const duration = Date.now() - startTime;
      logger.log(`[Response] ${req.method} ${req.originalUrl} - ${res.statusCode} (${duration}ms)`);
    });

    next();
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false, // Allow extra fields (needed for webhook payloads)
    }),
  );

  // API prefix - exclude health check endpoints
  app.setGlobalPrefix('api', {
    exclude: ['/', 'health'],
  });

  const port = configService.get('PORT') || 3002;
  await app.listen(port, '0.0.0.0');

  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  const baseUrl = configService.get('BASE_URL') || process.env.BASE_URL || (railwayDomain ? `https://${railwayDomain}` : null) || '(not set)';
  console.log(`Sigcore Backend running on port ${port}, BASE_URL=${baseUrl} (config=${configService.get('BASE_URL')}, env=${process.env.BASE_URL}, railway=${railwayDomain})`);
}

bootstrap();
