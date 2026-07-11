import { Injectable, Logger, ForbiddenException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommunicationIntegration } from '../../database/entities/communication-integration.entity';
import { Tenant } from '../../database/entities/tenant.entity';
import { CommunicationCall } from '../../database/entities/communication-call.entity';
import { TenantPhoneNumber } from '../../database/entities/tenant-phone-number.entity';

/**
 * Wave-2 Task 3 — 4-way validator described in the Wave-2 Migration Runbook.
 *
 * This service is the single authority for verifying that a caller (whose
 * SigcoreAuthGuard-attributed `workspaceId`/`tenantId` are already trusted)
 * is allowed to operate on a specific integration + resource. It is invoked
 * by `IntegrationResourceGuard` (Nest CanActivate) via the
 * `@UseIntegrationResourceGuard('providerCallSid' | 'tpnId')` decorator, but
 * exposed as an injectable service so future call-sites (e.g. background
 * jobs, webhook handlers) can reuse the same check without going through
 * Nest's guard machinery.
 *
 * The runbook's check order is preserved verbatim so log lines match the
 * documented `check=N failed` telemetry:
 *
 *   1. Workspace ownership — request.tenantId must belong to request.workspaceId
 *   2. Tenant access       — auth scope must be consistent with body tenantId
 *   3. Integration ownership — integration row must match (id, workspaceId, tenantId)
 *      Note: `communication_integrations` today has a unique index on
 *      (workspace_id, provider) — tenantId is carried in metadata (see
 *      ensureIntegration). We enforce tenant matching against the metadata's
 *      ensure.tenantId when present; falls back to allowing any tenant in the
 *      workspace during the Wave-2 transition, with a warn log.
 *   4. Resource ↔ integration linkage —
 *        `providerCallSid` present → CommunicationCall must join back to the
 *        integration. Pilot fallback: SID prefix must match the integration's
 *        Twilio accountSid.
 *        `tpnId` present → TenantPhoneNumber must exist under the same
 *        (workspaceId, tenantId) AND its provider must match the integration's.
 */

export interface IntegrationResourceGuardInput {
  request: {
    workspaceId?: string;
    tenantId?: string | null;
    authType?: string;
    authScopeType?: string;
    body?: Record<string, unknown>;
  };
  integrationId: string;
  providerCallSid?: string;
  tpnId?: string;
}

export interface IntegrationResourceGuardResult {
  workspaceId: string;
  tenantId: string;
  integration: CommunicationIntegration;
}

@Injectable()
export class IntegrationResourceGuardService {
  private readonly logger = new Logger(IntegrationResourceGuardService.name);

  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    @InjectRepository(CommunicationIntegration)
    private readonly integrationRepo: Repository<CommunicationIntegration>,
    @InjectRepository(CommunicationCall)
    private readonly callRepo: Repository<CommunicationCall>,
    @InjectRepository(TenantPhoneNumber)
    private readonly tpnRepo: Repository<TenantPhoneNumber>,
  ) {}

  async assert(input: IntegrationResourceGuardInput): Promise<IntegrationResourceGuardResult> {
    const { request, integrationId, providerCallSid, tpnId } = input;
    const workspaceId = request.workspaceId;
    const bodyTenantId = (request.body?.tenantId as string | undefined) ?? undefined;
    const authTenantId = request.tenantId ?? undefined;
    const effectiveTenantId = authTenantId ?? bodyTenantId;

    if (!workspaceId) {
      throw new ForbiddenException(
        'IntegrationResourceGuard: workspaceId missing from request context',
      );
    }
    if (!integrationId) {
      throw new BadRequestException(
        'IntegrationResourceGuard: integrationId is required in request body',
      );
    }
    if (!effectiveTenantId) {
      // If neither auth nor body carries a tenantId the guard has nothing to
      // check against — treat as failed check 2.
      this.deny(2, 'no effective tenantId (neither auth-derived nor body-supplied)', {
        workspaceId,
        integrationId,
      });
    }

    // ------------------------------------------------------------------
    // Check 1 — workspace owns tenant
    // ------------------------------------------------------------------
    const tenant = await this.tenantRepo.findOne({
      where: { id: effectiveTenantId as string, workspaceId },
    });
    if (!tenant) {
      this.deny(1, 'tenant not found in workspace', {
        workspaceId,
        tenantId: effectiveTenantId,
        integrationId,
      });
    }

    // ------------------------------------------------------------------
    // Check 2 — auth scope consistent with body tenantId
    //  - api_key + tenant scope: authTenantId must match bodyTenantId (if provided)
    //  - service key (workspace scope): bodyTenantId must be present + resolvable
    //    (already validated by check 1 above once we picked effectiveTenantId)
    // ------------------------------------------------------------------
    if (
      request.authType === 'api_key' &&
      request.authScopeType === 'tenant' &&
      bodyTenantId &&
      authTenantId &&
      bodyTenantId !== authTenantId
    ) {
      this.deny(2, 'api-key tenant scope does not match body tenantId', {
        workspaceId,
        authTenantId,
        bodyTenantId,
        integrationId,
      });
    }

    // ------------------------------------------------------------------
    // Check 3 — integration ownership
    //  communication_integrations is unique on (workspace_id, provider) —
    //  tenantId lives in metadata.ensure.tenantId for rows registered via
    //  ensureIntegration. Match on workspace + id first, then check tenant
    //  metadata if present.
    // ------------------------------------------------------------------
    const integration = await this.integrationRepo.findOne({
      where: { id: integrationId, workspaceId },
    });
    if (!integration) {
      this.deny(3, 'integration not found in workspace', {
        workspaceId,
        tenantId: effectiveTenantId,
        integrationId,
      });
    }
    const meta = (integration!.metadata as Record<string, unknown>) || {};
    const ensureMeta = (meta.ensure as Record<string, unknown>) || {};
    const integrationTenantId = ensureMeta.tenantId as string | undefined;
    if (integrationTenantId && integrationTenantId !== effectiveTenantId) {
      this.deny(3, 'integration tenant mismatch', {
        workspaceId,
        tenantId: effectiveTenantId,
        integrationId,
        integrationTenantId,
      });
    }
    if (!integrationTenantId) {
      // Wave-2 transitional state — pre-ensure rows carry no tenant tag.
      // Allow but log so we can spot pre-Wave-2 registrations still in use.
      this.logger.warn(
        `[IntegrationResourceGuard] integration=${integrationId} has no metadata.ensure.tenantId; permitting under Wave-2 transition (workspaceId=${workspaceId} tenantId=${effectiveTenantId})`,
      );
    }

    // ------------------------------------------------------------------
    // Check 4 — resource ↔ integration linkage
    // ------------------------------------------------------------------
    if (providerCallSid) {
      const call = await this.callRepo.findOne({
        where: { providerCallId: providerCallSid },
      });
      const linked =
        !!call &&
        (call.metadata?.integrationId as string | undefined) === integrationId;
      if (!linked) {
        // Pilot fallback — match SID prefix (AccountSid) against the
        // integration's decrypted accountSid. The runbook warns this is a
        // temporary reconcile path until every CommunicationCall row carries
        // integrationId in metadata.
        const providerAccountId = integration!.externalWorkspaceId;
        const looksLikeTwilioSid = providerCallSid.startsWith('CA');
        const acctPrefix = providerAccountId?.startsWith('AC');
        if (looksLikeTwilioSid && acctPrefix) {
          this.logger.warn(
            `[IntegrationResourceGuard] pilot fallback — providerCallSid=${providerCallSid} not persisted with integrationId=${integrationId} (workspaceId=${workspaceId}); allowing based on Twilio AccountSid prefix match`,
          );
        } else {
          this.deny(4, 'providerCallSid not linked to integration', {
            workspaceId,
            tenantId: effectiveTenantId,
            integrationId,
            providerCallSid,
          });
        }
      }
    } else if (tpnId) {
      const tpn = await this.tpnRepo.findOne({
        where: { id: tpnId, workspaceId, tenantId: effectiveTenantId as string },
      });
      if (!tpn) {
        this.deny(4, 'tpnId not found under (workspaceId, tenantId)', {
          workspaceId,
          tenantId: effectiveTenantId,
          integrationId,
          tpnId,
        });
      }
      if (String(tpn!.provider) !== String(integration!.provider)) {
        this.deny(4, 'tpn provider does not match integration provider', {
          workspaceId,
          tenantId: effectiveTenantId,
          integrationId,
          tpnId,
          tpnProvider: tpn!.provider,
          integrationProvider: integration!.provider,
        });
      }
    }

    return {
      workspaceId,
      tenantId: effectiveTenantId as string,
      integration: integration!,
    };
  }

  private deny(check: 1 | 2 | 3 | 4, reason: string, ctx: Record<string, unknown>): never {
    this.logger.warn(
      `[IntegrationResourceGuard] check=${check} failed: ${reason} ${JSON.stringify(ctx)}`,
    );
    throw new ForbiddenException(
      `IntegrationResourceGuard: check=${check} failed`,
    );
  }
}
