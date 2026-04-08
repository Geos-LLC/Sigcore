import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/**
 * Guard for Service Flow → Sigcore authentication via JWT-like signed tokens.
 *
 * SF sends: Authorization: Bearer <token>
 * Token format: base64({ tenantId, workspaceId, userId, exp }) + '.' + HMAC-SHA256 signature
 *
 * Shared secret: SF_AUTH_SECRET env var (must match on both SF and Sigcore)
 */
@Injectable()
export class SfAuthGuard implements CanActivate {
  private readonly logger = new Logger(SfAuthGuard.name);

  constructor(private readonly configService: ConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    const authHeader = request.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authorization: Bearer <token> required');
    }

    const token = authHeader.substring(7);
    const secret = this.configService.get<string>('SF_AUTH_SECRET');
    if (!secret) {
      this.logger.error('SF_AUTH_SECRET not configured');
      throw new UnauthorizedException('SF auth not configured');
    }

    // Token format: <base64_payload>.<signature>
    const dotIndex = token.lastIndexOf('.');
    if (dotIndex === -1) {
      throw new UnauthorizedException('Invalid token format');
    }

    const payloadB64 = token.substring(0, dotIndex);
    const signature = token.substring(dotIndex + 1);

    // Verify HMAC-SHA256 signature
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(payloadB64)
      .digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSig, 'hex'))) {
      throw new UnauthorizedException('Invalid token signature');
    }

    // Decode payload
    let payload: { tenantId: string; workspaceId: string; userId?: string; exp?: number };
    try {
      payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
    } catch {
      throw new UnauthorizedException('Invalid token payload');
    }

    // Check expiration
    if (payload.exp && Date.now() > payload.exp) {
      throw new UnauthorizedException('Token expired');
    }

    // Validate required fields
    if (!payload.tenantId || !payload.workspaceId) {
      throw new UnauthorizedException('Token must include tenantId and workspaceId');
    }

    // Attach to request context (same shape as SigcoreAuthGuard)
    request.workspaceId = payload.workspaceId;
    request.tenantId = payload.tenantId;
    request.userId = payload.userId || null;
    request.authType = 'sf_token';
    request.authScopeType = 'tenant';

    return true;
  }
}
