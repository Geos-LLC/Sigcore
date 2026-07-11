import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';

// Kept for backward-compat with the earlier metadata-based design; unused now.
export const REQUIRES_WORKSPACE_SCOPE_KEY = 'requiresWorkspaceScope';

/**
 * Guard that enforces workspace-scoped auth for admin/multi-tenant endpoints.
 * Applied directly via `@UseGuards(RequireWorkspaceScopeGuard)` (typically
 * through the `@RequiresWorkspaceScope()` convenience decorator, which wraps
 * it in `applyDecorators`). Runs after SigcoreAuthGuard sets
 * `request.authScopeType`.
 *
 * HISTORY: this guard was originally global (registered via APP_GUARD) and
 * relied on `Reflector.getAllAndOverride` to detect the marker. That path
 * silently failed at runtime in production on 2026-07-11 (local unit tests
 * + metadata reproduction passed, prod behavior said metadata not found).
 * Rewired to be a directly-applied guard because @UseGuards uses Nest's own
 * well-exercised metadata path (same one SigcoreAuthGuard rides on).
 */
@Injectable()
export class RequireWorkspaceScopeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
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
