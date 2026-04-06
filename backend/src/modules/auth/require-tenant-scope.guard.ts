import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const REQUIRES_TENANT_SCOPE_KEY = 'requiresTenantScope';

/**
 * Guard that enforces tenant-scoped auth for communication data APIs.
 * Blocks workspace-scoped keys from accessing tenant-isolated data.
 *
 * IMPORTANT: This guard must run AFTER SigcoreAuthGuard (which sets request.tenantId).
 * It is registered as a global guard via APP_GUARD to ensure correct ordering.
 * Use @RequiresTenantScope() decorator to mark endpoints that need tenant scope.
 */
@Injectable()
export class RequireTenantScopeGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiresTenant = this.reflector.getAllAndOverride<boolean>(
      REQUIRES_TENANT_SCOPE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiresTenant) return true;

    const request = context.switchToHttp().getRequest();
    const tenantId = request.tenantId;
    const authScopeType = request.authScopeType;

    if (!tenantId || authScopeType !== 'tenant') {
      const method = request.method;
      const url = request.url;
      const workspaceId = request.workspaceId;
      console.warn(
        `[TENANT_SCOPE_BLOCKED] ${method} ${url} | workspaceId=${workspaceId} | tenantId=${tenantId || 'null'} | authScopeType=${authScopeType || 'unknown'}`,
      );
      throw new ForbiddenException(
        'Tenant-scoped API key required for communication data access. Workspace keys cannot access tenant-isolated data.',
      );
    }

    return true;
  }
}
