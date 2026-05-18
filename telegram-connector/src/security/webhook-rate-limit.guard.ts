import { CanActivate, ExecutionContext, Injectable, Logger, TooManyRequestsException } from '@nestjs/common';

interface Counter { count: number; resetAt: number }

@Injectable()
export class WebhookRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(WebhookRateLimitGuard.name);
  private buckets = new Map<string, Counter>();
  private readonly limit = 600; // per window
  private readonly windowMs = 60_000;

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const ip = (req?.headers?.['x-forwarded-for'] as string) || req?.ip || 'unknown';
    const key = String(ip).split(',')[0].trim();
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    bucket.count++;
    if (bucket.count > this.limit) {
      throw new TooManyRequestsException('rate_limited');
    }
    return true;
  }
}
