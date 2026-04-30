import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { PhoneNumberAssignment } from '../../database/entities/phone-number-assignment.entity';
import { Tenant } from '../../database/entities/tenant.entity';
import { Workspace } from '../../database/entities/workspace.entity';
import {
  SmsMessage,
  SmsDirection,
} from '../../database/entities/sms-message.entity';
import { InventoryService } from './inventory.service';
import {
  LegacyAssignmentGroup,
  LegacySmsRow,
  InventoryRow,
} from './dto/admin-views.types';

const SMS_DEFAULT_LIMIT = 100;
const SMS_HARD_LIMIT = 500;

@Injectable()
export class LegacyService {
  private readonly logger = new Logger(LegacyService.name);

  constructor(
    @InjectRepository(PhoneNumberAssignment)
    private readonly pnaRepo: Repository<PhoneNumberAssignment>,
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    @InjectRepository(Workspace)
    private readonly workspaceRepo: Repository<Workspace>,
    @InjectRepository(SmsMessage)
    private readonly smsRepo: Repository<SmsMessage>,
    private readonly inventoryService: InventoryService,
  ) {}

  /**
   * List every phone_number_assignments row scoped to the calling workspace
   * (either business_id = workspaceId or business_id IN (workspace's tenants)),
   * grouped by business_id with workspace/tenant/unknown resolution.
   */
  async listAssignments(workspaceId: string): Promise<LegacyAssignmentGroup[]> {
    const tenants = await this.tenantRepo.find({
      where: { workspaceId },
      select: ['id', 'name'],
    });
    const tenantNameById = new Map<string, string>(tenants.map((t) => [t.id, t.name]));
    const tenantIdSet = new Set<string>(tenants.map((t) => t.id));

    const workspace = await this.workspaceRepo.findOne({ where: { id: workspaceId } });

    const qb = this.pnaRepo
      .createQueryBuilder('p')
      .where('p.business_id = :workspaceId', { workspaceId });
    if (tenantIdSet.size > 0) {
      qb.orWhere('p.business_id IN (:...tenantIds)', {
        tenantIds: Array.from(tenantIdSet),
      });
    }
    const rows = await qb.getMany();

    const groupsByBusinessId = new Map<string, LegacyAssignmentGroup>();
    for (const row of rows) {
      let group = groupsByBusinessId.get(row.businessId);
      if (!group) {
        const resolution = this.resolveBusinessId(row.businessId, workspaceId, tenantIdSet);
        const resolvedName =
          resolution === 'workspace'
            ? workspace?.name ?? null
            : resolution === 'tenant'
            ? tenantNameById.get(row.businessId) ?? null
            : null;
        group = {
          businessId: row.businessId,
          resolution,
          resolvedName,
          rows: [],
        };
        groupsByBusinessId.set(row.businessId, group);
      }
      group.rows.push({
        id: row.id,
        numberE164: row.numberE164,
        type: row.type as 'BOT' | 'DEDICATED',
        region: row.region ?? null,
        active: row.active,
        createdAt:
          row.createdAt instanceof Date
            ? row.createdAt.toISOString()
            : String(row.createdAt),
      });
    }

    // Sort groups: workspace first, then tenants alphabetically by resolved name,
    // then unknown last.
    const groups = Array.from(groupsByBusinessId.values()).sort((a, b) => {
      const order = { workspace: 0, tenant: 1, unknown: 2 } as const;
      const ord = order[a.resolution] - order[b.resolution];
      if (ord !== 0) return ord;
      return (a.resolvedName ?? a.businessId).localeCompare(
        b.resolvedName ?? b.businessId,
      );
    });

    // Sort rows within each group by createdAt ascending.
    for (const g of groups) {
      g.rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }

    return groups;
  }

  /**
   * Numbers present in BOTH tenant_phone_numbers AND phone_number_assignments.
   * Delegates to InventoryService to keep the merge logic in one place.
   */
  async listDuplications(workspaceId: string): Promise<InventoryRow[]> {
    return this.inventoryService.listDuplications(workspaceId);
  }

  /**
   * Recent rows from the legacy sms_messages table, scoped to the workspace
   * (either business_id = workspaceId or business_id IN tenants).
   */
  async listSmsMessages(
    workspaceId: string,
    limit: number = SMS_DEFAULT_LIMIT,
  ): Promise<LegacySmsRow[]> {
    const cappedLimit = Math.min(
      limit && limit > 0 ? limit : SMS_DEFAULT_LIMIT,
      SMS_HARD_LIMIT,
    );

    const tenants = await this.tenantRepo.find({
      where: { workspaceId },
      select: ['id'],
    });
    const tenantIdSet = new Set<string>(tenants.map((t) => t.id));
    const businessIds = [workspaceId, ...tenantIdSet];

    const rows = await this.smsRepo.find({
      where: { businessId: In(businessIds) },
      order: { createdAt: 'DESC' },
      take: cappedLimit,
    });

    return rows.map((m) => ({
      id: m.id,
      businessId: m.businessId,
      resolution: this.resolveBusinessId(m.businessId, workspaceId, tenantIdSet),
      direction:
        m.direction === SmsDirection.INBOUND ? 'INBOUND' : 'OUTBOUND',
      status: String(m.status),
      fromNumber: m.fromNumber,
      toNumber: m.toNumber,
      body: m.body,
      providerSid: m.providerSid ?? null,
      createdAt:
        m.createdAt instanceof Date
          ? m.createdAt.toISOString()
          : String(m.createdAt),
    }));
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
