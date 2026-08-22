import {
  Injectable,
  CanActivate,
  ExecutionContext,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IntegrationResourceGuardService } from './integration-resource-guard.service';
import {
  INTEGRATION_RESOURCE_KEY,
  INTEGRATION_RESOURCE_OPERATION_KEY,
  IntegrationResourceKind,
} from './use-integration-resource-guard.decorator';
import {
  verifyCallCapability,
  CSC_HEADER_NAME,
  CallScopedOperation,
} from './call-scoped-capability.util';
import { CommunicationCall } from '../../database/entities/communication-call.entity';
import { CommunicationIntegration } from '../../database/entities/communication-integration.entity';

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
 *
 * 2026-08-22 (G-6, CSC — Call-Scoped Capability, post-security-review) —
 * When the request carries a valid `X-Sigcore-Call-Capability` header,
 * the guard takes a DIFFERENT authorization path.
 *
 * TRUST MODEL: Sigcore is the SOLE issuer of capabilities. The signing
 * secret (SIGCORE_CALL_CAPABILITY_SECRET) lives on Sigcore ONLY. Callio
 * holds only the opaque capability value Sigcore forwarded during the
 * inbound-call envelope, echoes it on admin ops, and never signs anything.
 * A compromised Callio CANNOT mint capabilities for unrelated calls,
 * elevate allowedOps, or extend expiry.
 *
 * Verification steps:
 *   1. Verify the capability (HMAC signed by Sigcore, canonical payload
 *      binding callSid + integrationId + allowedOps + iat + exp + nonce).
 *   2. Check payload.callSid === URL param callSid (cross-call replay).
 *   3. Check current endpoint operation ∈ payload.allowedOps
 *      (cross-operation replay / privilege escalation).
 *   4. Check now within [iat, exp] window (expiry).
 *   5. Look up CommunicationCall by capability.callSid.
 *   6. Require call.metadata.integrationId === capability.integrationId
 *      (defense in depth: even a valid capability must match the actual
 *      call's stamped integration ownership).
 *   7. Resolve workspace/tenant from the integration itself (so callers
 *      never need to send workspace/tenant that they don't own).
 *   8. Attach `request.resource` from the resolved integration.
 *
 * The capability grants authority to THIS specific operation on THIS
 * specific call within [iat, exp] — nothing more. No workspace or tenant
 * authority is transferred.
 *
 * Backward-compat: when no `X-Sigcore-Call-Capability` header is present,
 * the legacy 4-check workspace-scoped path runs verbatim (used by Spotless
 * + every pre-CSC caller).
 *
 * When a capability header IS present but fails verification (any reason
 * from the CSC util), we reject with 403 — we do NOT silently fall
 * through to the workspace-scoped path. A caller sending a capability is
 * signaling intent; if it's broken, that's an error to surface, not a
 * hint to try a less-specific auth path.
 */
@Injectable()
export class IntegrationResourceGuard implements CanActivate {
  private readonly logger = new Logger(IntegrationResourceGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly svc: IntegrationResourceGuardService,
    private readonly configService: ConfigService,
    @InjectRepository(CommunicationCall)
    private readonly callRepo: Repository<CommunicationCall>,
    @InjectRepository(CommunicationIntegration)
    private readonly integrationRepo: Repository<CommunicationIntegration>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const kind = this.reflector.getAllAndOverride<IntegrationResourceKind | undefined>(
      INTEGRATION_RESOURCE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!kind) return true;

    const request = context.switchToHttp().getRequest();
    const params = request.params || {};

    // ── CSC fast path — when the header is present, this is the ONLY
    // authorization path. Fail on any verification failure; do NOT silently
    // fall back to workspace-scoped auth. Sigcore is the sole capability
    // issuer; Callio holds the opaque value and echoes it here.
    const headers = (request.headers ?? {}) as Record<string, unknown>;
    const capabilityHeader = headers[CSC_HEADER_NAME] as string | undefined;
    if (capabilityHeader) {
      return this.canActivateCallScoped(context, kind, params, request, capabilityHeader);
    }

    // ── Legacy path — workspace-scoped 4-check chain via the service.
    // Preserved verbatim for backward-compat with every pre-CSAP caller
    // (Spotless and every other tenant whose Callio workspace happens to
    // share LB's Sigcore workspace). Same behavior byte-for-byte as
    // pre-G-6.
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

  /**
   * G-6 CSC verify-then-authorize (Sigcore-issued capability).
   *
   * Only applies to `providerCallSid` endpoints — a TPN-scoped webhook-config
   * write is not a per-call operation and doesn't have a CallSid to bind to.
   * TPN endpoints must continue using the workspace-scoped path.
   */
  private async canActivateCallScoped(
    context: ExecutionContext,
    kind: IntegrationResourceKind,
    params: Record<string, unknown>,
    request: any,
    capabilityHeader: string,
  ): Promise<boolean> {
    if (kind !== 'providerCallSid') {
      // Defensive: a capability header on a non-call endpoint is a client
      // bug. Reject rather than silently ignore.
      throw new BadRequestException(
        `X-Sigcore-Call-Capability header is only valid on providerCallSid endpoints (got kind='${kind}')`,
      );
    }
    const providerCallSid = params.providerCallSid as string | undefined;
    if (!providerCallSid) {
      throw new BadRequestException('providerCallSid path parameter is required');
    }

    const expectedOperation = this.reflector.getAllAndOverride<CallScopedOperation | null>(
      INTEGRATION_RESOURCE_OPERATION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!expectedOperation) {
      // The decorator on this endpoint didn't declare an operation string.
      // A CSC capability cannot be validated without an expected operation
      // to bind against — bail rather than authorize on partial state.
      this.logger.warn(
        `[CSC] capability header received on an endpoint that did not declare an operation via @UseIntegrationResourceGuard — rejecting to prevent under-scoped authorization`,
      );
      throw new ForbiddenException(
        'CSC capability present but endpoint operation is not declared',
      );
    }

    const secret = this.configService.get<string>('SIGCORE_CALL_CAPABILITY_SECRET') ?? null;
    const capResult = verifyCallCapability({
      headerValue: capabilityHeader,
      secret,
      expectedOperation,
      expectedCallSid: providerCallSid,
    });
    if (capResult.outcome !== 'ok') {
      this.logger.warn(
        `[CSC] capability rejected reason=${capResult.reason}` +
          (capResult.detail ? ` detail=${capResult.detail}` : '') +
          ` callSid=${providerCallSid} op=${expectedOperation}`,
      );
      throw new ForbiddenException(
        `Call-scoped capability rejected: ${capResult.reason}`,
      );
    }
    const { payload } = capResult;

    // Resource ↔ integration linkage — defense in depth.
    // The capability asserts an integrationId (signed by Sigcore);
    // the CommunicationCall row's stamped integrationId is authoritative
    // ground truth from actual call state. Even a valid Sigcore-issued
    // capability must match the actual call ownership — a mismatch means
    // Sigcore's issuance state and its call state have diverged, which is
    // never expected and must not authorize.
    const call = await this.callRepo.findOne({
      where: { providerCallId: providerCallSid },
    });
    if (!call) {
      this.logger.warn(
        `[CSC] call not found for providerCallSid=${providerCallSid} (capability was authentic; call must be persisted before admin ops)`,
      );
      throw new ForbiddenException('Call resource not found');
    }
    const stampedIntegrationId =
      (call.metadata?.integrationId as string | undefined) ?? null;
    if (!stampedIntegrationId) {
      // Wave-4 (2026-08-14) landed integrationId stamping on
      // CommunicationCall.metadata for every new inbound. Rows without it
      // are pre-Wave-4 legacy — CSC requires the stamp to be present.
      this.logger.warn(
        `[CSC] call ${providerCallSid} has no metadata.integrationId — CSC requires the stamp; rejecting`,
      );
      throw new ForbiddenException(
        'CSC capability cannot be validated: call has no stamped integrationId',
      );
    }
    if (stampedIntegrationId !== payload.integrationId) {
      this.logger.warn(
        `[CSC] integration mismatch — capability.integrationId=${payload.integrationId} but call.metadata.integrationId=${stampedIntegrationId} for callSid=${providerCallSid}`,
      );
      throw new ForbiddenException(
        'CSC capability integrationId does not match the call resource',
      );
    }

    // Resolve workspace / tenant from the integration itself. CSC never
    // requires the caller to send workspace or tenant IDs — the capability
    // is the identity, and the integration row is the anchor.
    const integration = await this.integrationRepo.findOne({
      where: { id: payload.integrationId },
    });
    if (!integration) {
      this.logger.warn(
        `[CSC] integration ${payload.integrationId} not found (capability authentic, call matches — but integration deleted?)`,
      );
      throw new ForbiddenException('Integration resource not found');
    }
    // Derive tenantId: prefer the integration's owner_tenant_id column,
    // fall back to legacy metadata.ensure.tenantId, then to the call's
    // tenant reference if the CommunicationCall carries one.
    const meta = (integration.metadata as Record<string, unknown>) || {};
    const ensureMeta = (meta.ensure as Record<string, unknown>) || {};
    const legacyTenantId = ensureMeta.tenantId as string | undefined;
    const columnOwnerTenantId = integration.ownerTenantId ?? undefined;
    const resolvedTenantId =
      columnOwnerTenantId ??
      legacyTenantId ??
      ((call as unknown as { tenantId?: string }).tenantId ?? null);

    request.resource = {
      workspaceId: integration.workspaceId,
      tenantId: resolvedTenantId,
      integration,
    };

    this.logger.log(
      `[CSC] authorized op=${expectedOperation} callSid=${providerCallSid} ` +
        `integration=${payload.integrationId} workspace=${integration.workspaceId} ` +
        `tenant=${resolvedTenantId ?? 'null'} (call-scoped path)`,
    );

    return true;
  }
}
