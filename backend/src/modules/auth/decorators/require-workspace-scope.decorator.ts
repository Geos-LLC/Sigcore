import { SetMetadata } from '@nestjs/common';
import { REQUIRES_WORKSPACE_SCOPE_KEY } from '../require-workspace-scope.guard';

/**
 * Marks an endpoint or controller as requiring workspace-scoped auth.
 * The RequireWorkspaceScopeGuard rejects tenant-scoped keys with 403.
 *
 * Usage:
 *   @RequiresWorkspaceScope()
 *   @Post('provision')
 *   async provisionTenant(...) { }
 */
export const RequiresWorkspaceScope = () => SetMetadata(REQUIRES_WORKSPACE_SCOPE_KEY, true);
