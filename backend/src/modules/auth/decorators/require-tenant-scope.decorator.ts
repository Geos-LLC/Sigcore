import { SetMetadata } from '@nestjs/common';
import { REQUIRES_TENANT_SCOPE_KEY } from '../require-tenant-scope.guard';

/**
 * Marks an endpoint or controller as requiring tenant-scoped auth.
 * The RequireTenantScopeGuard (registered as APP_GUARD) reads this metadata
 * and rejects workspace-scoped keys with 403.
 *
 * Usage:
 *   @RequiresTenantScope()
 *   @Get('conversations')
 *   async getConversations(...) { }
 */
export const RequiresTenantScope = () => SetMetadata(REQUIRES_TENANT_SCOPE_KEY, true);
