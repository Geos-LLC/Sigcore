import { SfAuthGuard } from './sf-auth.guard';
import { UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const SECRET = 'test-sf-secret-key-32chars-long!!';

function buildGuard(secret: string | undefined = SECRET) {
  const configService = { get: jest.fn().mockReturnValue(secret) };
  const guard = new SfAuthGuard(configService as any);
  return { guard, configService };
}

function createToken(payload: Record<string, unknown>, secret: string = SECRET): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  const signature = crypto.createHmac('sha256', secret).update(payloadB64).digest('hex');
  return `${payloadB64}.${signature}`;
}

function mockContext(headers: Record<string, string> = {}) {
  const request: any = { headers };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    request,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('SfAuthGuard', () => {
  describe('valid tokens', () => {
    it('allows request with valid signed token', async () => {
      const { guard } = buildGuard();
      const token = createToken({ tenantId: 'tenant-1', workspaceId: 'ws-1', userId: 'user-1' });
      const ctx = mockContext({ authorization: `Bearer ${token}` });

      const result = await guard.canActivate(ctx as any);

      expect(result).toBe(true);
      expect(ctx.request.workspaceId).toBe('ws-1');
      expect(ctx.request.tenantId).toBe('tenant-1');
      expect(ctx.request.userId).toBe('user-1');
      expect(ctx.request.authType).toBe('sf_token');
      expect(ctx.request.authScopeType).toBe('tenant');
    });

    it('allows token without userId (sets null)', async () => {
      const { guard } = buildGuard();
      const token = createToken({ tenantId: 'tenant-1', workspaceId: 'ws-1' });
      const ctx = mockContext({ authorization: `Bearer ${token}` });

      await guard.canActivate(ctx as any);

      expect(ctx.request.userId).toBeNull();
    });

    it('allows token with future expiration', async () => {
      const { guard } = buildGuard();
      const token = createToken({
        tenantId: 'tenant-1',
        workspaceId: 'ws-1',
        exp: Date.now() + 60000,
      });
      const ctx = mockContext({ authorization: `Bearer ${token}` });

      const result = await guard.canActivate(ctx as any);
      expect(result).toBe(true);
    });

    it('allows token without exp (no expiration)', async () => {
      const { guard } = buildGuard();
      const token = createToken({ tenantId: 'tenant-1', workspaceId: 'ws-1' });
      const ctx = mockContext({ authorization: `Bearer ${token}` });

      const result = await guard.canActivate(ctx as any);
      expect(result).toBe(true);
    });
  });

  describe('rejected tokens', () => {
    it('rejects missing Authorization header', async () => {
      const { guard } = buildGuard();
      const ctx = mockContext({});

      await expect(guard.canActivate(ctx as any)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects non-Bearer auth', async () => {
      const { guard } = buildGuard();
      const ctx = mockContext({ authorization: 'Basic abc123' });

      await expect(guard.canActivate(ctx as any)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects when SF_AUTH_SECRET not configured', async () => {
      const configService = { get: jest.fn().mockReturnValue(null) };
      const guard = new SfAuthGuard(configService as any);
      const token = createToken({ tenantId: 'tenant-1', workspaceId: 'ws-1' });
      const ctx = mockContext({ authorization: `Bearer ${token}` });

      await expect(guard.canActivate(ctx as any)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects token without dot separator', async () => {
      const { guard } = buildGuard();
      const ctx = mockContext({ authorization: 'Bearer nodothere' });

      await expect(guard.canActivate(ctx as any)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects token signed with wrong secret', async () => {
      const { guard } = buildGuard();
      const token = createToken({ tenantId: 'tenant-1', workspaceId: 'ws-1' }, 'wrong-secret-key-32chars-long!!!');
      const ctx = mockContext({ authorization: `Bearer ${token}` });

      await expect(guard.canActivate(ctx as any)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects expired token', async () => {
      const { guard } = buildGuard();
      const token = createToken({
        tenantId: 'tenant-1',
        workspaceId: 'ws-1',
        exp: Date.now() - 1000,
      });
      const ctx = mockContext({ authorization: `Bearer ${token}` });

      await expect(guard.canActivate(ctx as any)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects token missing tenantId', async () => {
      const { guard } = buildGuard();
      const token = createToken({ workspaceId: 'ws-1' });
      const ctx = mockContext({ authorization: `Bearer ${token}` });

      await expect(guard.canActivate(ctx as any)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects token missing workspaceId', async () => {
      const { guard } = buildGuard();
      const token = createToken({ tenantId: 'tenant-1' });
      const ctx = mockContext({ authorization: `Bearer ${token}` });

      await expect(guard.canActivate(ctx as any)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects malformed payload (invalid base64)', async () => {
      const { guard } = buildGuard();
      const badPayload = '!!!not-base64!!!';
      const sig = crypto.createHmac('sha256', SECRET).update(badPayload).digest('hex');
      const ctx = mockContext({ authorization: `Bearer ${badPayload}.${sig}` });

      await expect(guard.canActivate(ctx as any)).rejects.toThrow(UnauthorizedException);
    });
  });
});
