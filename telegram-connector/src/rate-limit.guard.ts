import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';

/**
 * Token-bucket-ish rate limiter keyed by client IP. Cheap, in-memory, and
 * applied specifically to the public Telegram webhook endpoint, which is the
 * only route reachable by untrusted callers.
 */
@Injectable()
export class WebhookRateLimitGuard implements CanActivate {
  private readonly windowMs = 60_000;
  private readonly maxPerWindow = 600; // Telegram bursts during chat backfills
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<{ ip?: string; headers: Record<string, string | string[] | undefined> }>();
    const ip = pickIp(req);
    const now = Date.now();
    const bucket = this.hits.get(ip);
    if (!bucket || bucket.resetAt < now) {
      this.hits.set(ip, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    bucket.count += 1;
    if (bucket.count > this.maxPerWindow) {
      throw new HttpException('rate_limited', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}

function pickIp(req: { ip?: string; headers: Record<string, string | string[] | undefined> }): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string') return fwd.split(',')[0].trim();
  if (Array.isArray(fwd) && fwd[0]) return String(fwd[0]).split(',')[0].trim();
  return req.ip || 'unknown';
}