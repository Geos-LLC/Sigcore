import { applyDecorators, UseGuards } from '@nestjs/common';
import { RequireWorkspaceScopeGuard } from '../require-workspace-scope.guard';

/**
 * Marks an endpoint as requiring workspace-scoped auth.
 * Applies RequireWorkspaceScopeGuard directly via @UseGuards — the guard runs
 * whenever the decorator is present, no metadata reflection required.
 *
 * Usage:
 *   @RequiresWorkspaceScope()
 *   @Post('provision')
 *   async provisionTenant(...) { }
 */
export const RequiresWorkspaceScope = () =>
  applyDecorators(UseGuards(RequireWorkspaceScopeGuard));
