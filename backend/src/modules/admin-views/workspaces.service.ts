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
import { WorkspaceSummary as WorkspaceSummaryDto } from './dto/admin-views.types';

export interface WorkspaceFilters {
  platformId?: string;
  /** Hide tenants whose name still looks like the auto-generated "Account <uuid>" stub. */
  hideUnnamedTenants?: boolean;
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
  ): Promise<WorkspaceSummaryDto[]> {
    const tenants = await this.tenantRepo.find({
      where: { workspaceId },
      select: ['id', 'name', 'workspaceId'],
    });
    if (tenants.length === 0) return [];

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

    return summaries.filter((s) => this.passesFilters(s, filters));
  }

  private passesFilters(s: WorkspaceSummary, f: WorkspaceFilters): boolean {
    if (f.platformId && s.platformId !== f.platformId) return false;
    if (f.hideUnnamedTenants && /^Account\s+[a-f0-9-]{8,}/i.test(s.displayName)) {
      return false;
    }
    return true;
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
