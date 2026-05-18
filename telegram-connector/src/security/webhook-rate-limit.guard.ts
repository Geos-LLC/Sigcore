import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';

interface Entry { count: number; resetAt: number; }

/** In-memory IP rate limit for public webhook endpoints. */
@Injectable()
export class WebhookRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(WebhookRateLimitGuard.name);
  private readonly store = new Map<string, Entry>();
  private readonly limit = parseInt(process.env.TELEGRAM_WEBHOOK_RATE_LIMIT || '600', 10) || 600;
  private readonly windowMs = 60 * 1000;

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const ip = this.ip(req);
    const now = Date.now();
    const key = `webhook:${ip}`;
    const entry = this.store.get(key);

    if (!entry || now > entry.resetAt) {
      this.store.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count++;
    if (entry.count > this.limit) {
      this.logger.warn(`rate limit exceeded ip=${ip}`);
      throw new HttpException(
        { statusCode: HttpStatus.TOO_MANY_REQUESTS, retryAfter: Math.ceil((entry.resetAt - now) / 1000) },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }

  private ip(req: Request): string {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) {
      const list = (typeof fwd === 'string' ? fwd : fwd[0]).split(',');
      return list[0].trim();
    }
    const real = req.headers['x-real-ip'];
    if (real) return typeof real === 'string' ? real : real[0];
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }
}
