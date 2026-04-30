import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TenantPhoneNumber } from '../../database/entities/tenant-phone-number.entity';
import { PhoneNumberAssignment } from '../../database/entities/phone-number-assignment.entity';
import { Tenant } from '../../database/entities/tenant.entity';
import {
  InventoryRow,
  InventoryCurrentBlock,
  InventoryLegacyBlock,
  PhoneModelBadge,
} from './dto/admin-views.types';

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
}
