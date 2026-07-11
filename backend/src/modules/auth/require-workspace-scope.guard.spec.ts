import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { RequireWorkspaceScopeGuard } from './require-workspace-scope.guard';

describe('RequireWorkspaceScopeGuard', () => {
  let guard: RequireWorkspaceScopeGuard;

  const createMockContext = (request: Record<string, unknown>): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    guard = new RequireWorkspaceScopeGuard();
  });

  it('allows workspace-scoped key', () => {
    const ctx = createMockContext({
      authScopeType: 'workspace',
      workspaceId: 'ws-1',
      method: 'POST',
      url: '/tenants/provision',
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects tenant-scoped key', () => {
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

  it('rejects tenant scope on DELETE /tenants/orphans (workspace-admin cleanup)', () => {
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
    const ctx = createMockContext({
      tenantId: 'callio-tenant',
      authScopeType: 'tenant',
      workspaceId: 'ws-shared',
      method: 'POST',
      url: '/tenants/some-lb-tenant/api-keys',
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('allows service-key workspace scope', () => {
    const ctx = createMockContext({
      authScopeType: 'workspace',
      workspaceId: 'ws-1',
      method: 'POST',
      url: '/tenants',
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
