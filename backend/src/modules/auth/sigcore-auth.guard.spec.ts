import { SigcoreAuthGuard } from './sigcore-auth.guard';
import { UnauthorizedException } from '@nestjs/common';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function buildGuard(serviceKey = 'test-service-key') {
  const configService = { get: jest.fn().mockReturnValue(serviceKey) };
  const apiKeyRepo = {
    findOne: jest.fn(),
    save: jest.fn(async (entity: any) => entity),
  };
  const guard = new SigcoreAuthGuard(configService as any, apiKeyRepo as any);
  return { guard, configService, apiKeyRepo };
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
describe('SigcoreAuthGuard', () => {
  // ===================== Service-to-service auth =====================
  describe('X-Sigcore-Key (service-to-service)', () => {
    it('allows request with valid service key + workspace ID', async () => {
      const { guard } = buildGuard('secret-key');
      const ctx = mockContext({
        'x-sigcore-key': 'secret-key',
        'x-workspace-id': 'ws-1',
      });

      const result = await guard.canActivate(ctx as any);

      expect(result).toBe(true);
      expect(ctx.request.workspaceId).toBe('ws-1');
      expect(ctx.request.authType).toBe('service');
    });

    it('rejects invalid service key', async () => {
      const { guard } = buildGuard('correct-key');
      const ctx = mockContext({
        'x-sigcore-key': 'wrong-key',
        'x-workspace-id': 'ws-1',
      });

      await expect(guard.canActivate(ctx as any)).rejects.toThrow(UnauthorizedException);
    });

    it('rejects missing workspace ID with valid service key', async () => {
      const { guard } = buildGuard('key');
      const ctx = mockContext({ 'x-sigcore-key': 'key' });

      await expect(guard.canActivate(ctx as any)).rejects.toThrow(UnauthorizedException);
    });
  });

  // ===================== External API key auth =====================
  describe('x-api-key (external)', () => {
    it('allows request with valid workspace-scoped API key', async () => {
      const { guard, apiKeyRepo } = buildGuard();
      const apiKey = {
        key: 'sc_abc123',
        workspaceId: 'ws-1',
        tenantId: null,
        scope: 'workspace',
        active: true,
        lastUsedAt: null,
      };
      apiKeyRepo.findOne.mockResolvedValue(apiKey);

      const ctx = mockContext({ 'x-api-key': 'sc_abc123' });
      const result = await guard.canActivate(ctx as any);

      expect(result).toBe(true);
      expect(ctx.request.workspaceId).toBe('ws-1');
      expect(ctx.request.tenantId).toBeNull();
      expect(ctx.request.apiKeyScope).toBe('workspace');
      expect(ctx.request.authType).toBe('api_key');
      expect(apiKeyRepo.save).toHaveBeenCalled();
    });

    it('allows request with valid tenant-scoped API key and sets tenantId', async () => {
      const { guard, apiKeyRepo } = buildGuard();
      const apiKey = {
        key: 'sc_tenant_def456',
        workspaceId: 'ws-1',
        tenantId: 'tenant-1',
        scope: 'tenant',
        active: true,
        lastUsedAt: null,
      };
      apiKeyRepo.findOne.mockResolvedValue(apiKey);

      const ctx = mockContext({ 'x-api-key': 'sc_tenant_def456' });
      const result = await guard.canActivate(ctx as any);

      expect(result).toBe(true);
      expect(ctx.request.workspaceId).toBe('ws-1');
      expect(ctx.request.tenantId).toBe('tenant-1');
      expect(ctx.request.apiKeyScope).toBe('tenant');
    });

    it('rejects invalid API key', async () => {
      const { guard, apiKeyRepo } = buildGuard();
      apiKeyRepo.findOne.mockResolvedValue(null);

      const ctx = mockContext({ 'x-api-key': 'sc_invalid' });
      await expect(guard.canActivate(ctx as any)).rejects.toThrow(UnauthorizedException);
    });
  });

  // ===================== No auth =====================
  describe('no authentication', () => {
    it('rejects request with no auth headers', async () => {
      const { guard } = buildGuard();
      const ctx = mockContext({});

      await expect(guard.canActivate(ctx as any)).rejects.toThrow(UnauthorizedException);
    });
  });

  // ===================== X-User-Id per-user scope =====================
  // Callio's proxy today authenticates via x-api-key, so X-User-Id must be
  // readable on BOTH paths. Absence is legacy-compatible (workspace-only
  // scope). Malformed values fail loud rather than silently degrading — a
  // malformed value is a bug on the consumer side, not a runtime condition.
  describe('X-User-Id per-user scope', () => {
    describe('on the x-sigcore-key (service) path', () => {
      it('attaches userId when a well-formed X-User-Id is supplied', async () => {
        const { guard } = buildGuard('key');
        const ctx = mockContext({
          'x-sigcore-key': 'key',
          'x-workspace-id': 'ws-1',
          'x-user-id': 'user-abc-123',
        });

        const result = await guard.canActivate(ctx as any);

        expect(result).toBe(true);
        expect(ctx.request.userId).toBe('user-abc-123');
      });

      it('leaves userId undefined when X-User-Id is absent (legacy preserved)', async () => {
        const { guard } = buildGuard('key');
        const ctx = mockContext({
          'x-sigcore-key': 'key',
          'x-workspace-id': 'ws-1',
        });

        await guard.canActivate(ctx as any);
        expect(ctx.request.userId).toBeUndefined();
      });
    });

    describe('on the x-api-key path (Callio proxy uses this today)', () => {
      it('attaches userId when a well-formed X-User-Id is supplied', async () => {
        const { guard, apiKeyRepo } = buildGuard();
        apiKeyRepo.findOne.mockResolvedValue({
          key: 'sc_abc123',
          workspaceId: 'ws-1',
          tenantId: null,
          scope: 'workspace',
          active: true,
          lastUsedAt: null,
        });

        const ctx = mockContext({
          'x-api-key': 'sc_abc123',
          'x-user-id': 'user-abc-123',
        });

        const result = await guard.canActivate(ctx as any);
        expect(result).toBe(true);
        expect(ctx.request.userId).toBe('user-abc-123');
        expect(ctx.request.workspaceId).toBe('ws-1');
      });

      it('leaves userId undefined when X-User-Id is absent (legacy consumers)', async () => {
        const { guard, apiKeyRepo } = buildGuard();
        apiKeyRepo.findOne.mockResolvedValue({
          key: 'sc_abc123',
          workspaceId: 'ws-1',
          tenantId: null,
          scope: 'workspace',
          active: true,
          lastUsedAt: null,
        });

        const ctx = mockContext({ 'x-api-key': 'sc_abc123' });
        await guard.canActivate(ctx as any);
        expect(ctx.request.userId).toBeUndefined();
      });
    });

    describe('validation (applied uniformly on both paths)', () => {
      it('rejects X-User-Id with disallowed characters', async () => {
        const { guard } = buildGuard('key');
        const ctx = mockContext({
          'x-sigcore-key': 'key',
          'x-workspace-id': 'ws-1',
          'x-user-id': 'user<script>',
        });

        await expect(guard.canActivate(ctx as any)).rejects.toThrow(UnauthorizedException);
      });

      it('rejects X-User-Id longer than 64 characters', async () => {
        const { guard } = buildGuard('key');
        const ctx = mockContext({
          'x-sigcore-key': 'key',
          'x-workspace-id': 'ws-1',
          'x-user-id': 'a'.repeat(65),
        });

        await expect(guard.canActivate(ctx as any)).rejects.toThrow(UnauthorizedException);
      });

      it('rejects empty X-User-Id header', async () => {
        const { guard } = buildGuard('key');
        const ctx = mockContext({
          'x-sigcore-key': 'key',
          'x-workspace-id': 'ws-1',
          'x-user-id': '',
        });

        await expect(guard.canActivate(ctx as any)).rejects.toThrow(UnauthorizedException);
      });
    });
  });
});
