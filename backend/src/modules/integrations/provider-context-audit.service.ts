import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommunicationIntegration } from '../../database/entities/communication-integration.entity';
import { TenantPhoneNumber } from '../../database/entities/tenant-phone-number.entity';

/**
 * Incident 2026-07-18 Wave-3 completion — provider-context audit.
 *
 * Read-only surface that enumerates the four classes of state that break
 * `ProviderContextResolver`'s deterministic routing:
 *
 *   1. duplicate_integrations   — >1 active `communication_integrations`
 *      matching (workspace, provider) under the SAME scope. The partial
 *      unique indexes should prevent this from ever happening, but the
 *      audit still checks in case an out-of-band write slipped past.
 *
 *   2. unstamped_tpns          — active TPNs with
 *      `communication_integration_id IS NULL`. Every such row forces the
 *      resolver's rule 1 (`by_number`) to fall through, which triggers
 *      the 409 whenever the workspace holds more than one integration.
 *
 *   3. legacy_workspace_rows   — integrations with `owner_tenant_id IS
 *      NULL` (WORKSPACE scope) but `metadata.ensure.tenantId` set —
 *      i.e. legacy rows still awaiting an ownership claim.
 *
 *   4. tenants_without_chain   — tenants missing the
 *      `communication_businesses` / `communication_profiles` /
 *      `profile_phone_assignments` chain that outbound resolution
 *      requires. Reuses the same shape the 2026-07-13 Spotless fix
 *      surfaced.
 *
 * Filters (all optional): workspaceId, tenantId, phone. Returns 200 with
 * the report; consumers key off the counts + row lists to drive the
 * Provider Context Dashboard and CI post-deploy gates.
 */
export interface DuplicateIntegrationRow {
  workspaceId: string;
  provider: string;
  scopeType: string;
  ownerTenantId: string | null;
  count: number;
  integrationIds: string[];
}

export interface UnstampedTpnRow {
  id: string;
  workspaceId: string;
  tenantId: string | null;
  phoneNumber: string;
  provider: string;
  status: string;
}

export interface LegacyWorkspaceRow {
  id: string;
  workspaceId: string;
  provider: string;
  metadataEnsureTenantId: string | null;
  createdAt: string;
}

export interface TenantWithoutChainRow {
  tenantId: string;
  workspaceId: string;
  hasBusiness: boolean;
  hasProfile: boolean;
  hasPpa: boolean;
}

export interface ProviderContextAuditReport {
  ts: string;
  filters: { workspaceId: string | null; tenantId: string | null; phone: string | null };
  counts: {
    duplicateIntegrations: number;
    unstampedTpns: number;
    legacyWorkspaceRows: number;
    tenantsWithoutChain: number;
  };
  duplicateIntegrations: DuplicateIntegrationRow[];
  unstampedTpns: UnstampedTpnRow[];
  legacyWorkspaceRows: LegacyWorkspaceRow[];
  tenantsWithoutChain: TenantWithoutChainRow[];
}

@Injectable()
export class ProviderContextAuditService {
  private readonly logger = new Logger(ProviderContextAuditService.name);

  constructor(
    @InjectRepository(CommunicationIntegration)
    private readonly integrationRepo: Repository<CommunicationIntegration>,
    @InjectRepository(TenantPhoneNumber)
    private readonly tpnRepo: Repository<TenantPhoneNumber>,
  ) {}

  async run(filters: {
    workspaceId?: string | null;
    tenantId?: string | null;
    phone?: string | null;
  } = {}): Promise<ProviderContextAuditReport> {
    const workspaceId = filters.workspaceId ?? null;
    const tenantId = filters.tenantId ?? null;
    const phone = filters.phone ?? null;

    const [duplicates, unstamped, legacy, chains] = await Promise.all([
      this.findDuplicateIntegrations(workspaceId),
      this.findUnstampedTpns(workspaceId, tenantId, phone),
      this.findLegacyWorkspaceRows(workspaceId),
      this.findTenantsWithoutChain(workspaceId, tenantId),
    ]);

    return {
      ts: new Date().toISOString(),
      filters: { workspaceId, tenantId, phone },
      counts: {
        duplicateIntegrations: duplicates.length,
        unstampedTpns: unstamped.length,
        legacyWorkspaceRows: legacy.length,
        tenantsWithoutChain: chains.length,
      },
      duplicateIntegrations: duplicates,
      unstampedTpns: unstamped,
      legacyWorkspaceRows: legacy,
      tenantsWithoutChain: chains,
    };
  }

  private async findDuplicateIntegrations(
    workspaceId: string | null,
  ): Promise<DuplicateIntegrationRow[]> {
    // Group active rows by (workspace, provider, scope, owner). Any group
    // with count > 1 is a partial-unique violation and must be investigated.
    const filterClause = workspaceId ? `AND workspace_id = $1` : '';
    const params = workspaceId ? [workspaceId] : [];
    const sql = `
      SELECT
        workspace_id::text AS "workspaceId",
        provider,
        scope_type AS "scopeType",
        owner_tenant_id::text AS "ownerTenantId",
        COUNT(*)::int AS "count",
        ARRAY_AGG(id::text ORDER BY created_at) AS "integrationIds"
      FROM communication_integrations
      WHERE status = 'active'
        ${filterClause}
      GROUP BY workspace_id, provider, scope_type, owner_tenant_id
      HAVING COUNT(*) > 1
      ORDER BY workspace_id, provider
    `;
    return this.integrationRepo.query(sql, params);
  }

  private async findUnstampedTpns(
    workspaceId: string | null,
    tenantId: string | null,
    phone: string | null,
  ): Promise<UnstampedTpnRow[]> {
    const wheres: string[] = [
      "status = 'active'",
      'communication_integration_id IS NULL',
    ];
    const params: any[] = [];
    if (workspaceId) { params.push(workspaceId); wheres.push(`workspace_id = $${params.length}`); }
    if (tenantId) { params.push(tenantId); wheres.push(`tenant_id = $${params.length}`); }
    if (phone) { params.push(phone); wheres.push(`phone_number = $${params.length}`); }
    const sql = `
      SELECT
        id::text,
        workspace_id::text AS "workspaceId",
        tenant_id::text AS "tenantId",
        phone_number AS "phoneNumber",
        provider,
        status
      FROM tenant_phone_numbers
      WHERE ${wheres.join(' AND ')}
      ORDER BY workspace_id, tenant_id, phone_number
    `;
    return this.tpnRepo.query(sql, params);
  }

  private async findLegacyWorkspaceRows(
    workspaceId: string | null,
  ): Promise<LegacyWorkspaceRow[]> {
    // WORKSPACE-scoped rows carrying `metadata.ensure.tenantId` — legacy
    // rows that pre-date the ownership guard and haven't been claimed
    // to TENANT scope yet.
    const filterClause = workspaceId ? `AND workspace_id = $1` : '';
    const params = workspaceId ? [workspaceId] : [];
    const sql = `
      SELECT
        id::text,
        workspace_id::text AS "workspaceId",
        provider,
        (metadata->'ensure'->>'tenantId') AS "metadataEnsureTenantId",
        created_at AS "createdAt"
      FROM communication_integrations
      WHERE status = 'active'
        AND owner_tenant_id IS NULL
        AND (metadata->'ensure'->>'tenantId') IS NOT NULL
        ${filterClause}
      ORDER BY workspace_id, created_at
    `;
    return this.integrationRepo.query(sql, params);
  }

  private async findTenantsWithoutChain(
    workspaceId: string | null,
    tenantId: string | null,
  ): Promise<TenantWithoutChainRow[]> {
    // Tenants that own at least one active TPN but are missing part of
    // the outbound-resolution chain (business, profile, or PPA).
    const wheres: string[] = [
      "tpn.status = 'active'",
      'tpn.tenant_id IS NOT NULL',
    ];
    const params: any[] = [];
    if (workspaceId) { params.push(workspaceId); wheres.push(`tpn.workspace_id = $${params.length}`); }
    if (tenantId) { params.push(tenantId); wheres.push(`tpn.tenant_id = $${params.length}`); }

    const sql = `
      WITH tenants_with_tpn AS (
        SELECT DISTINCT tpn.tenant_id, tpn.workspace_id
        FROM tenant_phone_numbers tpn
        WHERE ${wheres.join(' AND ')}
      )
      SELECT
        t.tenant_id::text AS "tenantId",
        t.workspace_id::text AS "workspaceId",
        EXISTS (SELECT 1 FROM communication_businesses b WHERE b.tenant_id::text = t.tenant_id::text) AS "hasBusiness",
        EXISTS (SELECT 1 FROM communication_profiles p WHERE p.tenant_id::text = t.tenant_id::text) AS "hasProfile",
        EXISTS (
          SELECT 1
          FROM profile_phone_assignments ppa
          JOIN communication_profiles p ON p.id = ppa.profile_id
          WHERE p.tenant_id::text = t.tenant_id::text
            AND ppa.active = TRUE
        ) AS "hasPpa"
      FROM tenants_with_tpn t
      WHERE NOT EXISTS (SELECT 1 FROM communication_businesses b WHERE b.tenant_id::text = t.tenant_id::text)
         OR NOT EXISTS (SELECT 1 FROM communication_profiles p WHERE p.tenant_id::text = t.tenant_id::text)
         OR NOT EXISTS (
              SELECT 1
              FROM profile_phone_assignments ppa
              JOIN communication_profiles p ON p.id = ppa.profile_id
              WHERE p.tenant_id::text = t.tenant_id::text
                AND ppa.active = TRUE
            )
      ORDER BY t.workspace_id, t.tenant_id
    `;
    return this.tpnRepo.query(sql, params);
  }
}
