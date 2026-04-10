import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/**
 * Simple in-memory rate limiter for webhook endpoints
 * Limits requests per IP address
 *
 * Default: 100 requests per minute per IP
 */
@Injectable()
export class WebhookRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(WebhookRateLimitGuard.name);
  private readonly store = new Map<string, RateLimitEntry>();

  // Configuration — 600/min to handle WhatsApp auto-sync bursts
  private readonly limit = 600; // requests
  private readonly windowMs = 60 * 1000; // 1 minute

  // Cleanup interval (every 5 minutes)
  private readonly cleanupInterval = 5 * 60 * 1000;
  private lastCleanup = Date.now();

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const ip = this.getClientIp(request);

    // Periodic cleanup of expired entries
    this.cleanup();

    const now = Date.now();
    const key = `webhook:${ip}`;

    let entry = this.store.get(key);

    if (!entry || now > entry.resetAt) {
      // Create new entry
      entry = {
        count: 1,
        resetAt: now + this.windowMs,
      };
      this.store.set(key, entry);
      return true;
    }

    // Increment count
    entry.count++;

    if (entry.count > this.limit) {
      this.logger.warn(`Rate limit exceeded for IP: ${ip}`);
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too many requests. Please try again later.',
          retryAfter: Math.ceil((entry.resetAt - now) / 1000),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  private getClientIp(request: Request): string {
    // Check common proxy headers
    const forwarded = request.headers['x-forwarded-for'];
    if (forwarded) {
      const ips = (typeof forwarded === 'string' ? forwarded : forwarded[0]).split(',');
      return ips[0].trim();
    }

    const realIp = request.headers['x-real-ip'];
    if (realIp) {
      return typeof realIp === 'string' ? realIp : realIp[0];
    }

    return request.ip || request.socket.remoteAddress || 'unknown';
  }

  private cleanup(): void {
    const now = Date.now();
    if (now - this.lastCleanup < this.cleanupInterval) {
      return;
    }

    this.lastCleanup = now;
    let cleaned = 0;

    for (const [key, entry] of this.store.entries()) {
      if (now > entry.resetAt) {
        this.store.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.debug(`Cleaned up ${cleaned} expired rate limit entries`);
    }
  }
}
