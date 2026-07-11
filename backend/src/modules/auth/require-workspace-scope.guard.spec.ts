import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RequireWorkspaceScopeGuard } from './require-workspace-scope.guard';

describe('RequireWorkspaceScopeGuard', () => {
  let guard: RequireWorkspaceScopeGuard;
  let reflector: Reflector;

  const createMockContext = (request: Record<string, unknown>): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RequireWorkspaceScopeGuard(reflector);
  });

  it('allows workspace-scoped key on protected endpoint', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const ctx = createMockContext({
      authScopeType: 'workspace',
      workspaceId: 'ws-1',
      method: 'POST',
      url: '/tenants/provision',
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects tenant-scoped key on protected endpoint', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const ctx = createMockContext({
      tenantId: 'tenant-abc',
      authScopeType: 'tenant',
      workspaceId: 'ws-1',
      method: 'POST',
      url: '/tenants/provision',
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctx)).toThrow(
      'Workspace-scoped API key required',
    );
  });

  it('passes through when endpoint is not marked', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const ctx = createMockContext({
      tenantId: 'tenant-abc',
      authScopeType: 'tenant',
      workspaceId: 'ws-1',
      method: 'GET',
      url: '/tenants',
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects tenant scope on GET /tenants/orphans DELETE (workspace-admin cleanup)', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const ctx = createMockContext({
      tenantId: 'tenant-abc',
      authScopeType: 'tenant',
      workspaceId: 'ws-1',
      method: 'DELETE',
      url: '/tenants/orphans',
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('rejects tenant scope on POST /tenants/:id/api-keys (cross-tenant key mint)', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const ctx = createMockContext({
      tenantId: 'callio-tenant',
      authScopeType: 'tenant',
      workspaceId: 'ws-shared',
      method: 'POST',
      url: '/tenants/some-lb-tenant/api-keys',
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });
});
