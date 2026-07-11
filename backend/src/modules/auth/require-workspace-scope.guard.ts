import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const REQUIRES_WORKSPACE_SCOPE_KEY = 'requiresWorkspaceScope';

/**
 * Guard that enforces workspace-scoped auth for admin/multi-tenant endpoints.
 * Blocks tenant-scoped keys from accessing operations that span multiple tenants
 * (orphan cleanup, pricing config writes, cross-tenant reallocation, provisioning).
 *
 * Runs after SigcoreAuthGuard (which sets request.authScopeType). Registered
 * globally via APP_GUARD alongside RequireTenantScopeGuard.
 * Use @RequiresWorkspaceScope() decorator to mark admin-only endpoints.
 */
@Injectable()
export class RequireWorkspaceScopeGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiresWorkspace = this.reflector.getAllAndOverride<boolean>(
      REQUIRES_WORKSPACE_SCOPE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiresWorkspace) return true;

    const request = context.switchToHttp().getRequest();
    const authScopeType = request.authScopeType;

    if (authScopeType === 'tenant') {
      const method = request.method;
      const url = request.url;
      const tenantId = request.tenantId;
      console.warn(
        `[WORKSPACE_SCOPE_BLOCKED] ${method} ${url} | tenantId=${tenantId} | authScopeType=${authScopeType}`,
      );
      throw new ForbiddenException(
        'Workspace-scoped API key required. Tenant keys cannot access workspace-admin operations.',
      );
    }

    return true;
  }
}
