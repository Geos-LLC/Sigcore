import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { RequireTenantScopeGuard, REQUIRES_TENANT_SCOPE_KEY } from '../require-tenant-scope.guard';

/**
 * Decorator that enforces tenant-scoped auth on communication data endpoints.
 * Rejects workspace-scoped keys with 403.
 *
 * Usage:
 *   @RequiresTenantScope()
 *   @Get('conversations')
 *   async getConversations(...) { }
 */
export function RequiresTenantScope() {
  return applyDecorators(
    SetMetadata(REQUIRES_TENANT_SCOPE_KEY, true),
    UseGuards(RequireTenantScopeGuard),
  );
}
