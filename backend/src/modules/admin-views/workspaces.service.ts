import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { CommunicationBusiness } from '../../database/entities/communication-business.entity';
import { CommunicationProfile } from '../../database/entities/communication-profile.entity';
import { ProfilePhoneAssignment } from '../../database/entities/profile-phone-assignment.entity';
import { TenantPhoneNumber } from '../../database/entities/tenant-phone-number.entity';
import { Tenant } from '../../database/entities/tenant.entity';
import { attributePlatforms, AttributionTenant } from './platform-attribution';
import {
  AggregationBusiness,
  AggregationPhoneCounts,
  AggregationProfileCounts,
  AggregationTenant,
  WorkspaceSummary,
  aggregateWorkspaces,
} from './workspace-aggregation';
import {
  AdminListMeta,
  WorkspaceSummary as WorkspaceSummaryDto,
} from './dto/admin-views.types';
import {
  classifyWorkspace,
  workspaceIsVisible,
} from './classification';

export interface WorkspaceFilters {
  platformId?: string;
  /** Hide tenants whose name still looks like the auto-generated "Account <uuid>" stub. */
  hideUnnamedTenants?: boolean;
  /** PR14 — when true, include zombie workspaces. Default false. */
  includeZombies?: boolean;
  /** PR14 — when true, include platform-anchor tenants. Default false. */
  includeAnchors?: boolean;
}

@Injectable()
export class WorkspacesService {
  constructor(
    @InjectRepository(Tenant) private readonly tenantRepo: Repository<Tenant>,
    @InjectRepository(CommunicationBusiness)
    private readonly bizRepo: Repository<CommunicationBusiness>,
    @InjectRepository(CommunicationProfile)
    private readonly profileRepo: Repository<CommunicationProfile>,
    @InjectRepository(ProfilePhoneAssignment)
    private readonly ppaRepo: Repository<ProfilePhoneAssignment>,
    @InjectRepository(TenantPhoneNumber)
    private readonly tpnRepo: Repository<TenantPhoneNumber>,
  ) {}

  async list(
    workspaceId: string,
    filters: WorkspaceFilters = {},
  ): Promise<{ data: WorkspaceSummaryDto[]; meta: AdminListMeta }> {
    const tenants = await this.tenantRepo.find({
      where: { workspaceId },
      select: ['id', 'name', 'workspaceId', 'externalId'],
    });
    if (tenants.length === 0) {
      return {
        data: [],
        meta: { total: 0, visible: 0, hiddenZombies: 0, hiddenAnchors: 0 },
      };
    }

    const businesses = await this.bizRepo.find({
      where: { workspaceId },
    });

    const attribution = attributePlatforms(
      tenants.map<AttributionTenant>((t) => ({ id: t.id, name: t.name })),
    );

    const aggTenants: AggregationTenant[] = tenants.map((t) => ({
      id: t.id,
      name: t.name ?? null,
      workspaceId: t.workspaceId,
      platformId: attribution.byTenantId.get(t.id) ?? 'unclassified',
    }));

    const aggBusinesses: AggregationBusiness[] = businesses.map((b) => ({
      id: b.id,
      tenantId: b.tenantId,
      workspaceId: b.workspaceId,
      displayName: b.displayName,
      metadata: (b.metadata as Record<string, unknown> | null) ?? null,
    }));

    const profileCounts = await this.loadProfileCounts(businesses.map((b) => b.id));
    const phoneCounts = await this.loadPhoneCounts(businesses.map((b) => b.id));

    const summaries: WorkspaceSummary[] = aggregateWorkspaces(
      aggTenants,
      aggBusinesses,
      profileCounts,
      phoneCounts,
    );

    // Map ext-id by tenant id for classification (anchor detection by external_id pattern).
    const externalIdByTenantId = new Map(
      tenants.map((t) => [t.id, t.externalId ?? null]),
    );

    // Tag every summary with its PR14 classification, then filter.
    // PR14.2 — override platformId to 'leadbridge' when this is an LB
    // customer workspace (kind='lb_customer' or synthetic key starts with
    // 'lb-user-'). Tenant-level attribution can return 'unclassified' for
    // LB customers whose tenants were provisioned with bare "Account
    // <uuid>" names; the workspace identity makes the platform unambiguous.
    // Classification still uses the *raw* platformId so non-LB platforms
    // resolve correctly.
    const tagged = summaries.map((s) => {
      const classification = classifyWorkspace({
        kind: s.kind,
        platformId: s.platformId,
        displayName: s.displayName,
        tenantExternalId: externalIdByTenantId.get(s.primaryTenantId) ?? null,
      });
      const isLbCustomerWorkspace =
        s.kind === 'lb_customer' || s.key.startsWith('lb-user-');
      const displayPlatformId =
        isLbCustomerWorkspace && s.platformId === 'unclassified'
          ? 'leadbridge'
          : s.platformId;
      return {
        ...s,
        platformId: displayPlatformId,
        classification,
      };
    });

    const total = tagged.length;
    let hiddenZombies = 0;
    let hiddenAnchors = 0;
    const visible = tagged.filter((s) => {
      // Existing legacy "hide unnamed tenants" filter stays as-is.
      if (
        filters.hideUnnamedTenants &&
        /^Account\s+[a-f0-9-]{8,}/i.test(s.displayName)
      ) {
        return false;
      }
      if (filters.platformId && s.platformId !== filters.platformId) return false;
      const ok = workspaceIsVisible(s.classification, {
        includeZombies: filters.includeZombies,
        includeAnchors: filters.includeAnchors,
      });
      if (!ok) {
        if (s.classification === 'zombie') hiddenZombies++;
        else if (s.classification === 'anchor') hiddenAnchors++;
        return false;
      }
      return true;
    });

    return {
      data: visible,
      meta: {
        total,
        visible: visible.length,
        hiddenZombies,
        hiddenAnchors,
      },
    };
  }


  private async loadProfileCounts(
    businessIds: string[],
  ): Promise<AggregationProfileCounts> {
    const empty: AggregationProfileCounts = {
      byProfileId: new Map(),
      realProfilesPerBusiness: new Map(),
      allProfilesPerBusiness: new Map(),
    };
    if (businessIds.length === 0) return empty;

    const profiles = await this.profileRepo.find({
      where: { communicationBusinessId: In(businessIds) },
    });

    for (const p of profiles) {
      empty.byProfileId.set(p.id, {
        businessId: p.communicationBusinessId,
        tenantId: p.tenantId,
      });
      empty.allProfilesPerBusiness.set(
        p.communicationBusinessId,
        (empty.allProfilesPerBusiness.get(p.communicationBusinessId) ?? 0) + 1,
      );
      // "Real" = source not in {leadbridge, hirefunnel, serviceflow, callio, internal}
      // when slug='default'. After PR6 those rows have is_default=FALSE and the
      // real materialized row carries source='thumbtack'/'yelp' with is_default=TRUE.
      // Simpler & robust: count only rows whose slug !== 'default'.
      if (p.slug !== 'default') {
        empty.realProfilesPerBusiness.set(
          p.communicationBusinessId,
          (empty.realProfilesPerBusiness.get(p.communicationBusinessId) ?? 0) + 1,
        );
      }
    }
    return empty;
  }

  private async loadPhoneCounts(
    businessIds: string[],
  ): Promise<AggregationPhoneCounts> {
    const out: AggregationPhoneCounts = {
      phonesPerBusiness: new Map(),
    };
    if (businessIds.length === 0) return out;

    const rows = await this.ppaRepo
      .createQueryBuilder('ppa')
      .innerJoin(CommunicationProfile, 'p', 'p.id = ppa.profile_id')
      .innerJoin(TenantPhoneNumber, 'tpn', 'tpn.id = ppa.tenant_phone_number_id')
      .where('p.communication_business_id IN (:...ids)', { ids: businessIds })
      .andWhere('ppa.active = TRUE')
      .select([
        'p.communication_business_id AS business_id',
        'tpn.phone_number AS phone_number',
      ])
      .getRawMany<{ business_id: string; phone_number: string }>();

    for (const r of rows) {
      const set = out.phonesPerBusiness.get(r.business_id) ?? new Set<string>();
      set.add(r.phone_number);
      out.phonesPerBusiness.set(r.business_id, set);
    }
    return out;
  }
}
