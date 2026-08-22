import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import { IntegrationResourceGuard } from './integration-resource.guard';
import type { CallScopedOperation } from './call-scoped-capability.util';

export const INTEGRATION_RESOURCE_KEY = 'integrationResourceKind';
export const INTEGRATION_RESOURCE_OPERATION_KEY = 'integrationResourceOperation';

export type IntegrationResourceKind = 'providerCallSid' | 'tpnId';

/**
 * Wave-2 Task 3 — declarative wrapper for `IntegrationResourceGuard`.
 *
 * Usage:
 *   @UseIntegrationResourceGuard('providerCallSid', 'call.recording.start')
 *   @Post(':providerCallSid/recording/start')
 *   async startRecording(...) { ... }
 *
 * Sets the resource kind metadata so the guard knows which URL param to look
 * up (`providerCallSid` for call ops; `tpnId` for phone-number webhook config)
 * and attaches the guard itself. Combine with `@UseGuards(SigcoreAuthGuard)`
 * at the controller level — the guards run in registration order, so
 * SigcoreAuthGuard populates request.workspaceId/tenantId before this one.
 *
 * 2026-08-22 (G-6, CSC, post-security-review) — second optional argument
 * declares the `CallScopedOperation` the endpoint represents (e.g.,
 * 'call.hangup'). When the request carries an `X-Sigcore-Call-Capability`
 * header, the guard verifies the Sigcore-minted capability's `allowedOps`
 * includes THIS operation string. Preserves backward-compat: the
 * single-arg form still works and skips the call-scoped path when no
 * capability header is present. Only meaningful for kind='providerCallSid'
 * endpoints. Sigcore is the SOLE capability issuer — Callio holds only
 * the opaque header value it received during inbound forwarding.
 */
export function UseIntegrationResourceGuard(
  kind: IntegrationResourceKind,
  operation?: CallScopedOperation,
) {
  return applyDecorators(
    SetMetadata(INTEGRATION_RESOURCE_KEY, kind),
    SetMetadata(INTEGRATION_RESOURCE_OPERATION_KEY, operation ?? null),
    UseGuards(IntegrationResourceGuard),
  );
}
