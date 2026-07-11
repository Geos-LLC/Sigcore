import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { IntegrationResourceGuard } from './integration-resource.guard';

export const INTEGRATION_RESOURCE_KEY = 'integrationResourceKind';

export type IntegrationResourceKind = 'providerCallSid' | 'tpnId';

/**
 * Wave-2 Task 3 — declarative wrapper for `IntegrationResourceGuard`.
 *
 * Usage:
 *   @UseIntegrationResourceGuard('providerCallSid')
 *   @Post(':providerCallSid/recording/start')
 *   async startRecording(...) { ... }
 *
 * Sets the resource kind metadata so the guard knows which URL param to look
 * up (`providerCallSid` for call ops; `tpnId` for phone-number webhook config)
 * and attaches the guard itself. Combine with `@UseGuards(SigcoreAuthGuard)`
 * at the controller level — the guards run in registration order, so
 * SigcoreAuthGuard populates request.workspaceId/tenantId before this one.
 */
export const UseIntegrationResourceGuard = (kind: IntegrationResourceKind) =>
  applyDecorators(
    SetMetadata(INTEGRATION_RESOURCE_KEY, kind),
    UseGuards(IntegrationResourceGuard),
  );
