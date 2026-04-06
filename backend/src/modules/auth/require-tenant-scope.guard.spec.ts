import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequireTenantScopeGuard, REQUIRES_TENANT_SCOPE_KEY } from './require-tenant-scope.guard';

describe('RequireTenantScopeGuard', () => {
  let guard: RequireTenantScopeGuard;
  let reflector: Reflector;

  const createMockContext = (request: Record<string, unknown>): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RequireTenantScopeGuard(reflector);
  });

  it('should allow tenant-scoped key on protected endpoint', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const ctx = createMockContext({
      tenantId: 'tenant-abc',
      authScopeType: 'tenant',
      workspaceId: 'ws-1',
      method: 'GET',
      url: '/conversations',
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should reject workspace-scoped key on protected endpoint', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const ctx = createMockContext({
      tenantId: null,
      authScopeType: 'workspace',
      workspaceId: 'ws-1',
      method: 'GET',
      url: '/conversations',
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('should reject when tenantId is missing even with tenant authType', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const ctx = createMockContext({
      tenantId: undefined,
      authScopeType: 'tenant',
      workspaceId: 'ws-1',
      method: 'POST',
      url: '/integrations/sync',
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('should allow workspace key on non-protected endpoint', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const ctx = createMockContext({
      tenantId: null,
      authScopeType: 'workspace',
      workspaceId: 'ws-1',
      method: 'POST',
      url: '/tenants/provision',
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should reject workspace key calling sync', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const ctx = createMockContext({
      tenantId: null,
      authScopeType: 'workspace',
      workspaceId: 'ws-1',
      method: 'POST',
      url: '/integrations/sync',
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctx)).toThrow(
      'Tenant-scoped API key required for communication data access',
    );
  });

  it('should reject workspace key calling conversations list', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const ctx = createMockContext({
      tenantId: null,
      authScopeType: 'workspace',
      workspaceId: 'ws-1',
      method: 'GET',
      url: '/conversations',
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('should reject workspace key calling openphone conversations', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const ctx = createMockContext({
      tenantId: null,
      authScopeType: 'workspace',
      workspaceId: 'ws-1',
      method: 'GET',
      url: '/integrations/openphone/conversations',
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});
