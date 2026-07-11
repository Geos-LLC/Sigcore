import { Injectable, CanActivate, ExecutionContext, BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IntegrationResourceGuardService } from './integration-resource-guard.service';
import {
  INTEGRATION_RESOURCE_KEY,
  IntegrationResourceKind,
} from './use-integration-resource-guard.decorator';

/**
 * Wave-2 Task 3 — Nest CanActivate wrapper around
 * IntegrationResourceGuardService.
 *
 * Reads the `integrationResourceKind` metadata set by
 * `@UseIntegrationResourceGuard(...)` and delegates the actual validation to
 * the injectable service. Handlers without the metadata are permitted
 * (the guard is a no-op) — the decorator is the sole entry point in Wave-2.
 *
 * On success attaches `request.resource = { workspaceId, tenantId, integration }`
 * so downstream handlers can reuse the resolved integration without re-fetching.
 */
@Injectable()
export class IntegrationResourceGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly svc: IntegrationResourceGuardService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const kind = this.reflector.getAllAndOverride<IntegrationResourceKind | undefined>(
      INTEGRATION_RESOURCE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!kind) return true;

    const request = context.switchToHttp().getRequest();
    const params = request.params || {};
    const body = request.body || {};

    const integrationId = body.integrationId as string | undefined;
    if (!integrationId) {
      // Boundary case per runbook: missing integrationId returns 400, not 500.
      throw new BadRequestException('integrationId is required in request body');
    }

    const providerCallSid =
      kind === 'providerCallSid' ? (params.providerCallSid as string | undefined) : undefined;
    const tpnId = kind === 'tpnId' ? (params.tpnId as string | undefined) : undefined;

    if (kind === 'providerCallSid' && !providerCallSid) {
      throw new BadRequestException('providerCallSid path parameter is required');
    }
    if (kind === 'tpnId' && !tpnId) {
      throw new BadRequestException('tpnId path parameter is required');
    }

    const result = await this.svc.assert({
      request: {
        workspaceId: request.workspaceId,
        tenantId: request.tenantId,
        authType: request.authType,
        authScopeType: request.authScopeType,
        body,
      },
      integrationId,
      providerCallSid,
      tpnId,
    });

    request.resource = result;
    return true;
  }
}
