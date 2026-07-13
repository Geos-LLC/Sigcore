import * as crypto from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { CommunicationIdentity } from '../../database/entities/communication-identity.entity';
import {
  CommunicationIntegration,
  IntegrationStatus,
  ProviderType,
} from '../../database/entities/communication-integration.entity';
import { Tenant, TenantStatus } from '../../database/entities/tenant.entity';
import { Workspace } from '../../database/entities/workspace.entity';
import { EncryptionService } from '../../common/services/encryption.service';

import {
  CommunicationIdentityResponse,
  ProvisionCommunicationIdentityDto,
} from './dto/provision-communication-identity.dto';

/**
 * Wave-2 Task 6B.2 — Communication Identity provisioning.
 *
 * Sigcore is the owner of communication infrastructure. This service is the
 * single entry point through which a consuming product (Callio today,
 * others later) obtains that infrastructure. The service takes only the
 * consumer's own identifiers (`product`, `externalWorkspaceId`, optional
 * `workspaceName`, opaque `metadata`) and returns an opaque
 * `communicationIdentityId` plus the identifiers the consumer needs to
 * cache locally.
 *
 * Guarantees:
 *
 *   * Idempotent per (product, externalWorkspaceId). Repeated calls with
 *     the same pair return the same identity without creating duplicates.
 *     Enforced at the DB layer via a unique index, so a concurrent race
 *     resolves to one identity even if both callers pass the pre-lookup.
 *
 *   * Atomic. The Sigcore workspace, tenant, integration, and identity
 *     rows are inserted inside a single transaction. Any step failing
 *     rolls back all rows, leaving Sigcore's state unchanged.
 *
 *   * Products never supply provider credentials via this endpoint. The
 *     integration is created with an encrypted-empty credentials blob and
 *     marked `active`; a follow-up Sigcore-owned flow supplies real
 *     credentials before the integration is used for outbound provider
 *     calls. This preserves the ownership principle (Sigcore is the
 *     credential owner) without letting products mint the row.
 *
 *   * The default provider today is Twilio. Additional providers
 *     (OpenPhone, WhatsApp, Telegram, future ones) may be provisioned in
 *     the same call once multi-provider provisioning is on the table —
 *     the response shape is already an integration list. Twilio-only is
 *     a defaulting decision, not a contract shape.
 */
@Injectable()
export class ProvisioningService {
  private readonly logger = new Logger(ProvisioningService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly encryptionService: EncryptionService,
  ) {}

  async provisionCommunicationIdentity(
    dto: ProvisionCommunicationIdentityDto,
  ): Promise<CommunicationIdentityResponse> {
    // Fast idempotent path: if an identity for (product, externalWorkspaceId)
    // already exists, return it without opening a transaction. Safe because
    // creates are transactional and the DB unique index is the ultimate
    // arbiter — this is a warm-cache shortcut, not the correctness boundary.
    const existing = await this.findExistingIdentity(
      dto.product,
      dto.externalWorkspaceId,
    );
    if (existing) {
      this.logger.log(
        `provision_communication_identity_idempotent product=${dto.product} externalWorkspaceId=${maskId(dto.externalWorkspaceId)} workspaceId=${existing.workspaceId} tenantId=${existing.tenantId}`,
      );
      return existing;
    }

    return await this.createIdentityTransactionally(dto);
  }

  private async findExistingIdentity(
    product: string,
    externalWorkspaceId: string,
  ): Promise<CommunicationIdentityResponse | null> {
    const repo = this.dataSource.getRepository(CommunicationIdentity);
    const row = await repo.findOne({
      where: { product, externalWorkspaceId },
    });
    if (!row) return null;
    const integrations = await this.loadIntegrationsForWorkspace(
      row.workspaceId,
    );
    return this.toResponse(row, integrations);
  }

  private async loadIntegrationsForWorkspace(
    workspaceId: string,
  ): Promise<CommunicationIntegration[]> {
    return this.dataSource.getRepository(CommunicationIntegration).find({
      where: { workspaceId },
    });
  }

  private async createIdentityTransactionally(
    dto: ProvisionCommunicationIdentityDto,
  ): Promise<CommunicationIdentityResponse> {
    try {
      return await this.dataSource.transaction(async (mgr) => {
        // Re-check under the transaction — a concurrent request could have
        // won the race between the fast path and here.
        const identityRepo = mgr.getRepository(CommunicationIdentity);
        const winner = await identityRepo.findOne({
          where: {
            product: dto.product,
            externalWorkspaceId: dto.externalWorkspaceId,
          },
        });
        if (winner) {
          const integrations = await mgr
            .getRepository(CommunicationIntegration)
            .find({ where: { workspaceId: winner.workspaceId } });
          return this.toResponse(winner, integrations);
        }

        // 1) Workspace — a lightweight Sigcore reference row.
        const workspaceRepo = mgr.getRepository(Workspace);
        const workspace = await workspaceRepo.save(
          workspaceRepo.create({
            name: dto.workspaceName,
            webhookId: crypto.randomBytes(16).toString('hex'),
          }),
        );

        // 2) Tenant scoped to that workspace. `external_id` is a
        //    workspace-scoped human-readable slug per Sigcore convention.
        const tenantRepo = mgr.getRepository(Tenant);
        const tenant = await tenantRepo.save(
          tenantRepo.create({
            workspaceId: workspace.id,
            externalId: `${dto.product}-${dto.externalWorkspaceId}`,
            name: dto.workspaceName,
            status: TenantStatus.ACTIVE,
          }),
        );

        // 3) Default provider integration. Twilio is the default today;
        //    additional providers may be included by future work — the
        //    response shape is already a list. Credentials are Sigcore-
        //    owned; products never supply them here. We seed an
        //    encrypted-empty blob and mark active per the API contract; a
        //    later Sigcore flow injects real credentials before the
        //    integration is exercised end-to-end.
        const integrationRepo = mgr.getRepository(CommunicationIntegration);
        const integration = await integrationRepo.save(
          integrationRepo.create({
            workspaceId: workspace.id,
            provider: ProviderType.TWILIO,
            credentialsEncrypted: this.encryptionService.encrypt('{}'),
            status: IntegrationStatus.ACTIVE,
            metadata: {
              ensure: {
                tenantId: tenant.id,
                createdBy: 'provisioning-api',
                product: dto.product,
                createdAt: new Date().toISOString(),
              },
            },
          }),
        );

        // 4) Identity — the public handle. Unique index on
        //    (product, external_workspace_id) makes this the correctness
        //    boundary for idempotency; if two racers reach this point,
        //    exactly one INSERT wins and the loser hits a unique-violation
        //    that we translate below.
        const identity = await identityRepo.save(
          identityRepo.create({
            product: dto.product,
            externalWorkspaceId: dto.externalWorkspaceId,
            workspaceId: workspace.id,
            tenantId: tenant.id,
            metadata: dto.metadata ?? null,
          }),
        );

        this.logger.log(
          `provision_communication_identity_created product=${dto.product} externalWorkspaceId=${maskId(dto.externalWorkspaceId)} identityId=${identity.id} workspaceId=${workspace.id} tenantId=${tenant.id} integrationId=${integration.id}`,
        );

        return this.toResponse(identity, [integration]);
      });
    } catch (err) {
      // Concurrent race on the unique index — a peer transaction won.
      // Re-read and return the winning identity. This preserves the
      // "never create duplicates" invariant even under concurrent load.
      const code = extractPgCode(err);
      if (code === '23505') {
        this.logger.warn(
          `provision_communication_identity_race product=${dto.product} externalWorkspaceId=${maskId(dto.externalWorkspaceId)} — re-reading winning row`,
        );
        const winner = await this.findExistingIdentity(
          dto.product,
          dto.externalWorkspaceId,
        );
        if (winner) return winner;
      }
      // Any other failure — the transaction has already rolled back, so
      // no orphan rows exist. Surface the error.
      throw err;
    }
  }

  /**
   * Shape the persisted identity + its integrations into the public
   * response. `identity.id` is NOT surfaced — it is a Sigcore-internal
   * bookkeeping handle. Consumers rely on `workspaceId` + `tenantId` +
   * `integrations[]` today; any future opaque handle will be an additive
   * change on this shape.
   */
  private toResponse(
    identity: CommunicationIdentity,
    integrations: CommunicationIntegration[],
  ): CommunicationIdentityResponse {
    return {
      workspaceId: identity.workspaceId,
      tenantId: identity.tenantId,
      integrations: integrations.map((i) => ({
        provider: i.provider,
        integrationId: i.id,
        status: i.status,
      })),
    };
  }
}

function maskId(id: string): string {
  if (!id) return 'null';
  if (id.length <= 8) return '***';
  return `${id.slice(0, 4)}***${id.slice(-4)}`;
}

function extractPgCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as {
    code?: string;
    driverError?: { code?: string };
  };
  return e.code ?? e.driverError?.code;
}
