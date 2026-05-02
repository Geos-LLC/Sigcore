import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { TenantPhoneNumber } from '../../database/entities/tenant-phone-number.entity';
import { PhoneNumberAssignment } from '../../database/entities/phone-number-assignment.entity';
import { Tenant } from '../../database/entities/tenant.entity';
import { CommunicationBusiness } from '../../database/entities/communication-business.entity';
import { CommunicationProfile } from '../../database/entities/communication-profile.entity';
import { ProfilePhoneAssignment } from '../../database/entities/profile-phone-assignment.entity';
import {
  InventoryRow,
  InventoryCurrentBlock,
  InventoryLegacyBlock,
  InventoryAssignmentChainEntry,
  PhoneModelBadge,
} from './dto/admin-views.types';
import {
  attributePlatforms,
  AttributionTenant,
} from './platform-attribution';
import {
  AggregationBusiness,
  AggregationPhoneCounts,
  AggregationProfileCounts,
  AggregationTenant,
  aggregateWorkspaces,
  workspaceKeyForBusiness,
} from './workspace-aggregation';

const HARD_LIMIT = 500;
const DEFAULT_LIMIT = 200;

export interface InventoryFilters {
  /** Filter to a single model bucket. */
  model?: PhoneModelBadge | 'CURRENT' | 'LEGACY' | 'BOTH';
  /** Filter to a single provider name. */
  provider?: string;
  /** Page size. Capped at HARD_LIMIT. */
  limit?: number;
}

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    @InjectRepository(TenantPhoneNumber)
    private readonly tpnRepo: Repository<TenantPhoneNumber>,
    @InjectRepository(PhoneNumberAssignment)
    private readonly pnaRepo: Repository<PhoneNumberAssignment>,
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    @InjectRepository(CommunicationBusiness)
    private readonly bizRepo: Repository<CommunicationBusiness>,
    @InjectRepository(CommunicationProfile)
    private readonly profileRepo: Repository<CommunicationProfile>,
    @InjectRepository(ProfilePhoneAssignment)
    private readonly ppaRepo: Repository<ProfilePhoneAssignment>,
  ) {}

  /**
   * Build a unified phone-number inventory by merging tenant_phone_numbers
   * (current model) with phone_number_assignments (legacy model).
   *
   * Strategy: load both tables for the workspace, then merge in JS keyed on
   * the E.164 number. We avoid SQL FULL OUTER JOIN because TypeORM repos
   * don't expose it cleanly and the row counts are small.
   */
  async listPhoneNumbers(
    workspaceId: string,
    filters: InventoryFilters = {},
  ): Promise<InventoryRow[]> {
    const limit = Math.min(
      filters.limit && filters.limit > 0 ? filters.limit : DEFAULT_LIMIT,
      HARD_LIMIT,
    );

    // Load tenants + names once for join.
    const tenants = await this.tenantRepo.find({
      where: { workspaceId },
      select: ['id', 'name'],
    });
    const tenantNameById = new Map<string, string>(tenants.map((t) => [t.id, t.name]));
    const tenantIdSet = new Set<string>(tenants.map((t) => t.id));

    const [currents, legacies] = await Promise.all([
      this.tpnRepo.find({ where: { workspaceId } }),
      // phone_number_assignments has no workspace_id; business_id can be a
      // workspace id OR a tenant id. We query rows whose business_id is the
      // workspace itself OR any of the workspace's tenants.
      this.pnaRepo
        .createQueryBuilder('p')
        .where('p.business_id = :workspaceId', { workspaceId })
        .orWhere(
          tenantIdSet.size > 0 ? 'p.business_id IN (:...tenantIds)' : '1=0',
          { tenantIds: tenants.map((t) => t.id) },
        )
        .getMany(),
    ]);

    // Merge by phone number string.
    const byNumber = new Map<string, { current?: TenantPhoneNumber; legacy?: PhoneNumberAssignment }>();
    for (const row of currents) {
      const n = row.phoneNumber;
      const slot = byNumber.get(n) ?? {};
      slot.current = row;
      byNumber.set(n, slot);
    }
    for (const row of legacies) {
      const n = row.numberE164;
      const slot = byNumber.get(n) ?? {};
      slot.legacy = row;
      byNumber.set(n, slot);
    }

    // Resolve assignment chain (Platform → Workspace → Business → Profile)
    // for the CURRENT phones. We do this once for the whole result set rather
    // than per-row so the joins stay efficient.
    const chainByNumber = await this.buildChainsByNumber(
      workspaceId,
      currents,
      tenants,
    );

    const rows: InventoryRow[] = [];
    for (const [number, { current, legacy }] of byNumber.entries()) {
      const model = this.computeModel(current, legacy);

      const currentBlock: InventoryCurrentBlock | null = current
        ? {
            id: current.id,
            tenantId: current.tenantId,
            tenantName: tenantNameById.get(current.tenantId) ?? null,
            workspaceId: current.workspaceId,
            status: String(current.status),
          }
        : null;

      const legacyBlock: InventoryLegacyBlock | null = legacy
        ? {
            id: legacy.id,
            businessId: legacy.businessId,
            businessIdResolution: this.resolveBusinessId(
              legacy.businessId,
              workspaceId,
              tenantIdSet,
            ),
            type: legacy.type as 'BOT' | 'DEDICATED',
            active: legacy.active,
          }
        : null;

      const provider = current?.provider ?? null;
      const a2pStatus = current?.a2pStatus ?? null;

      rows.push({
        number,
        provider: provider ? String(provider) : null,
        a2pStatus,
        model,
        current: currentBlock,
        legacy: legacyBlock,
        chain: chainByNumber.get(number) ?? [],
      });
    }

    let filtered = rows;
    if (filters.model) {
      const wanted = String(filters.model).toUpperCase() as PhoneModelBadge;
      filtered = filtered.filter((r) => r.model === wanted);
    }
    if (filters.provider) {
      const wanted = String(filters.provider).toLowerCase();
      filtered = filtered.filter((r) => (r.provider ?? '').toLowerCase() === wanted);
    }

    // Stable sort: BOTH first, then LEGACY, then CURRENT, then by number ascending.
    const modelOrder: Record<PhoneModelBadge, number> = { BOTH: 0, LEGACY: 1, CURRENT: 2 };
    filtered.sort((a, b) => {
      const m = modelOrder[a.model] - modelOrder[b.model];
      if (m !== 0) return m;
      return a.number.localeCompare(b.number);
    });

    return filtered.slice(0, limit);
  }

  /**
   * Convenience method used by the legacy controller — same merge logic, but
   * filters down to the BOTH bucket only.
   */
  async listDuplications(workspaceId: string): Promise<InventoryRow[]> {
    const all = await this.listPhoneNumbers(workspaceId, {
      model: 'BOTH',
      limit: HARD_LIMIT,
    });
    return all;
  }

  private computeModel(
    current?: TenantPhoneNumber,
    legacy?: PhoneNumberAssignment,
  ): PhoneModelBadge {
    if (current && legacy) return 'BOTH';
    if (current) return 'CURRENT';
    return 'LEGACY';
  }

  private resolveBusinessId(
    businessId: string,
    workspaceId: string,
    tenantIdSet: Set<string>,
  ): 'workspace' | 'tenant' | 'unknown' {
    if (businessId === workspaceId) return 'workspace';
    if (tenantIdSet.has(businessId)) return 'tenant';
    return 'unknown';
  }

  /**
   * For each tenant_phone_numbers row, resolve the chain
   * Platform → Workspace → Business → Profile via active
   * profile_phone_assignments. A phone can resolve to multiple chains when
   * shared across profiles (M:N), so we return an array per number.
   */
  private async buildChainsByNumber(
    workspaceId: string,
    tpns: TenantPhoneNumber[],
    tenants: Array<{ id: string; name: string }>,
  ): Promise<Map<string, InventoryAssignmentChainEntry[]>> {
    const out = new Map<string, InventoryAssignmentChainEntry[]>();
    if (tpns.length === 0) return out;

    const tpnIds = tpns.map((t) => t.id);
    const tpnIdToNumber = new Map(tpns.map((t) => [t.id, t.phoneNumber]));

    const ppaRows = await this.ppaRepo
      .createQueryBuilder('ppa')
      .innerJoin(CommunicationProfile, 'p', 'p.id = ppa.profile_id')
      .where('ppa.tenant_phone_number_id IN (:...ids)', { ids: tpnIds })
      .andWhere('ppa.active = TRUE')
      .select([
        'ppa.tenant_phone_number_id AS tpn_id',
        'ppa.profile_id            AS profile_id',
        'ppa.is_default            AS is_default',
        'ppa.role                  AS role',
        'p.communication_business_id AS business_id',
        'p.tenant_id               AS tenant_id',
        'p.display_name            AS profile_display',
        'p.source                  AS profile_source',
      ])
      .getRawMany<{
        tpn_id: string;
        profile_id: string;
        is_default: boolean;
        role: string;
        business_id: string;
        tenant_id: string;
        profile_display: string;
        profile_source: string;
      }>();

    if (ppaRows.length === 0) return out;

    const businessIds = Array.from(new Set(ppaRows.map((r) => r.business_id)));
    const businesses = await this.bizRepo.find({
      where: { id: In(businessIds) },
    });
    const bizById = new Map(businesses.map((b) => [b.id, b]));

    // Build workspace lookup so each chain entry shows the right "workspace"
    // display name (lb-customer or solo-tenant).
    const attribution = attributePlatforms(
      tenants.map<AttributionTenant>((t) => ({ id: t.id, name: t.name })),
    );
    const aggTenants: AggregationTenant[] = tenants.map((t) => ({
      id: t.id,
      name: t.name ?? null,
      workspaceId,
      platformId: attribution.byTenantId.get(t.id) ?? 'unclassified',
    }));
    const aggBusinesses: AggregationBusiness[] = businesses.map((b) => ({
      id: b.id,
      tenantId: b.tenantId,
      workspaceId: b.workspaceId,
      displayName: b.displayName,
      metadata: (b.metadata as Record<string, unknown> | null) ?? null,
    }));
    const emptyProfileCounts: AggregationProfileCounts = {
      byProfileId: new Map(),
      realProfilesPerBusiness: new Map(),
      allProfilesPerBusiness: new Map(),
    };
    const emptyPhoneCounts: AggregationPhoneCounts = {
      phonesPerBusiness: new Map(),
    };
    const workspaces = aggregateWorkspaces(
      aggTenants,
      aggBusinesses,
      emptyProfileCounts,
      emptyPhoneCounts,
    );
    const workspaceByKey = new Map(workspaces.map((w) => [w.key, w]));

    for (const r of ppaRows) {
      const number = tpnIdToNumber.get(r.tpn_id);
      if (!number) continue;
      const business = bizById.get(r.business_id);
      const tenantPlatform =
        attribution.byTenantId.get(r.tenant_id) ?? 'unclassified';
      const wkey = business
        ? workspaceKeyForBusiness({
            tenantId: business.tenantId,
            metadata: business.metadata,
          })
        : `tenant-${r.tenant_id}`;
      const wks = workspaceByKey.get(wkey);
      const entry: InventoryAssignmentChainEntry = {
        platformId: tenantPlatform,
        workspaceKey: wkey,
        workspaceDisplayName:
          wks?.displayName ??
          tenants.find((t) => t.id === r.tenant_id)?.name ??
          `Workspace ${wkey.slice(0, 16)}`,
        businessId: business?.id ?? null,
        businessDisplayName: business?.displayName ?? null,
        profileId: r.profile_id,
        profileDisplayName: r.profile_display,
        profileSource: r.profile_source,
        isDefault: r.is_default,
        role: r.role,
      };
      const arr = out.get(number) ?? [];
      arr.push(entry);
      out.set(number, arr);
    }

    // Stable order: default first, then by role, then by businessDisplayName.
    for (const arr of out.values()) {
      arr.sort((a, b) => {
        if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
        const r = (a.role ?? '').localeCompare(b.role ?? '');
        if (r !== 0) return r;
        return (a.businessDisplayName ?? '').localeCompare(
          b.businessDisplayName ?? '',
        );
      });
    }
    return out;
  }
}
