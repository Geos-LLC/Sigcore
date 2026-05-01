import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { CommunicationBusiness } from '../../database/entities/communication-business.entity';
import { CommunicationProfile } from '../../database/entities/communication-profile.entity';
import { ProfilePhoneAssignment } from '../../database/entities/profile-phone-assignment.entity';
import { TenantPhoneNumber } from '../../database/entities/tenant-phone-number.entity';
import { Tenant } from '../../database/entities/tenant.entity';
import {
  attributePlatforms,
  AttributionTenant,
} from './platform-attribution';
import {
  BusinessSummary,
  BusinessDetail,
  BusinessPhoneRow,
  ProfileSummary,
} from './dto/admin-views.types';

export interface BusinessFilters {
  platformId?: string;
  source?: string;
  hasPhones?: boolean;
  hasSharedPhone?: boolean;
  hasExternalId?: boolean;
}

@Injectable()
export class BusinessesService {
  constructor(
    @InjectRepository(CommunicationBusiness)
    private readonly bizRepo: Repository<CommunicationBusiness>,
    @InjectRepository(CommunicationProfile)
    private readonly profileRepo: Repository<CommunicationProfile>,
    @InjectRepository(ProfilePhoneAssignment)
    private readonly ppaRepo: Repository<ProfilePhoneAssignment>,
    @InjectRepository(TenantPhoneNumber)
    private readonly tpnRepo: Repository<TenantPhoneNumber>,
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
  ) {}

  async list(workspaceId: string, filters: BusinessFilters = {}): Promise<BusinessSummary[]> {
    const businesses = await this.bizRepo.find({ where: { workspaceId } });
    if (businesses.length === 0) return [];

    const summaries = await this.buildSummaries(workspaceId, businesses);
    return this.applyFilters(summaries, filters);
  }

  async get(workspaceId: string, id: string): Promise<BusinessDetail> {
    const business = await this.bizRepo.findOne({ where: { id, workspaceId } });
    if (!business) {
      throw new NotFoundException(`Business ${id} not found`);
    }

    const [summary] = await this.buildSummaries(workspaceId, [business]);

    // Profiles under this business
    const profiles = await this.profileRepo.find({
      where: { communicationBusinessId: business.id },
    });
    const profileSummaries = await this.buildProfileSummaries(workspaceId, profiles);

    // Phones — distinct phones across all assignments under this business
    const phones = await this.buildPhoneRows(workspaceId, profiles);

    return {
      ...summary,
      profiles: profileSummaries,
      phones,
    };
  }

  // ---------------- helpers ----------------

  private async buildSummaries(
    workspaceId: string,
    businesses: CommunicationBusiness[],
  ): Promise<BusinessSummary[]> {
    if (businesses.length === 0) return [];
    const businessIds = businesses.map((b) => b.id);
    const tenantIds = Array.from(new Set(businesses.map((b) => b.tenantId)));

    const [profiles, ppaRows, tenants] = await Promise.all([
      this.profileRepo.find({ where: { communicationBusinessId: In(businessIds) } }),
      this.ppaRepo
        .createQueryBuilder('ppa')
        .innerJoin(CommunicationProfile, 'p', 'p.id = ppa.profile_id')
        .innerJoin(TenantPhoneNumber, 'tpn', 'tpn.id = ppa.tenant_phone_number_id')
        .where('p.communication_business_id IN (:...bizIds)', { bizIds: businessIds })
        .andWhere('ppa.active = TRUE')
        .select([
          'ppa.profile_id AS profile_id',
          'p.communication_business_id AS business_id',
          'tpn.phone_number AS phone_number',
        ])
        .getRawMany<{ profile_id: string; business_id: string; phone_number: string }>(),
      this.tenantRepo.find({
        where: { id: In(tenantIds) },
        select: ['id', 'name'],
      }),
    ]);

    const tenantById = new Map(tenants.map((t) => [t.id, t]));
    const profilesByBiz = new Map<string, CommunicationProfile[]>();
    for (const p of profiles) {
      const arr = profilesByBiz.get(p.communicationBusinessId) ?? [];
      arr.push(p);
      profilesByBiz.set(p.communicationBusinessId, arr);
    }

    // Phone counts + shared detection per business
    const phonesByBiz = new Map<string, Set<string>>();
    for (const r of ppaRows) {
      const set = phonesByBiz.get(r.business_id) ?? new Set();
      set.add(r.phone_number);
      phonesByBiz.set(r.business_id, set);
    }

    // Workspace-wide phone → profile count to detect shared phones (M:N).
    const phoneToProfileCount = new Map<string, number>();
    {
      const allWorkspacePpa = await this.ppaRepo
        .createQueryBuilder('ppa')
        .innerJoin(CommunicationProfile, 'p', 'p.id = ppa.profile_id')
        .innerJoin(TenantPhoneNumber, 'tpn', 'tpn.id = ppa.tenant_phone_number_id')
        .where('p.workspace_id = :ws', { ws: workspaceId })
        .andWhere('ppa.active = TRUE')
        .select(['tpn.phone_number AS phone_number', 'ppa.profile_id AS profile_id'])
        .getRawMany<{ phone_number: string; profile_id: string }>();
      const seen = new Map<string, Set<string>>();
      for (const r of allWorkspacePpa) {
        const set = seen.get(r.phone_number) ?? new Set<string>();
        set.add(r.profile_id);
        seen.set(r.phone_number, set);
      }
      for (const [phone, profSet] of seen) {
        phoneToProfileCount.set(phone, profSet.size);
      }
    }

    // Platform attribution for the involved tenants
    const attribution = attributePlatforms(
      tenants.map<AttributionTenant>((t) => ({ id: t.id, name: t.name })),
    );

    return businesses.map((b) => {
      const tenant = tenantById.get(b.tenantId);
      const bizProfiles = profilesByBiz.get(b.id) ?? [];
      const sources = Array.from(new Set(bizProfiles.map((p) => String(p.source))));
      const phoneSet = phonesByBiz.get(b.id) ?? new Set<string>();
      const phoneCount = phoneSet.size;
      const hasSharedPhone = Array.from(phoneSet).some(
        (n) => (phoneToProfileCount.get(n) ?? 0) > 1,
      );
      return {
        id: b.id,
        displayName: b.displayName,
        slug: b.slug,
        status: String(b.status),
        externalBusinessId: b.externalBusinessId ?? null,
        defaultProfileId: b.defaultProfileId ?? null,
        workspaceId: b.workspaceId,
        tenantId: b.tenantId,
        tenantName: tenant?.name ?? null,
        platformId: attribution.byTenantId.get(b.tenantId) ?? 'unclassified',
        profileCount: bizProfiles.length,
        phoneCount,
        sources,
        hasSharedPhone,
        createdAt: b.createdAt instanceof Date ? b.createdAt.toISOString() : String(b.createdAt),
      };
    });
  }

  private applyFilters(rows: BusinessSummary[], f: BusinessFilters): BusinessSummary[] {
    return rows.filter((r) => {
      if (f.platformId && r.platformId !== f.platformId) return false;
      if (f.source && !r.sources.includes(f.source)) return false;
      if (f.hasPhones && r.phoneCount === 0) return false;
      if (f.hasSharedPhone && !r.hasSharedPhone) return false;
      if (f.hasExternalId && !r.externalBusinessId) return false;
      return true;
    });
  }

  private async buildProfileSummaries(
    workspaceId: string,
    profiles: CommunicationProfile[],
  ): Promise<ProfileSummary[]> {
    if (profiles.length === 0) return [];
    const profileIds = profiles.map((p) => p.id);
    const businessIds = Array.from(new Set(profiles.map((p) => p.communicationBusinessId)));
    const tenantIds = Array.from(new Set(profiles.map((p) => p.tenantId)));

    const [businesses, tenants, ppaRows, sharedRows] = await Promise.all([
      this.bizRepo.find({ where: { id: In(businessIds) } }),
      this.tenantRepo.find({ where: { id: In(tenantIds) }, select: ['id', 'name'] }),
      this.ppaRepo
        .createQueryBuilder('ppa')
        .innerJoin(TenantPhoneNumber, 'tpn', 'tpn.id = ppa.tenant_phone_number_id')
        .where('ppa.profile_id IN (:...ids)', { ids: profileIds })
        .andWhere('ppa.active = TRUE')
        .select(['ppa.profile_id AS profile_id', 'tpn.phone_number AS phone_number'])
        .getRawMany<{ profile_id: string; phone_number: string }>(),
      this.ppaRepo
        .createQueryBuilder('ppa')
        .innerJoin(CommunicationProfile, 'p', 'p.id = ppa.profile_id')
        .innerJoin(TenantPhoneNumber, 'tpn', 'tpn.id = ppa.tenant_phone_number_id')
        .where('p.workspace_id = :ws', { ws: workspaceId })
        .andWhere('ppa.active = TRUE')
        .select(['tpn.phone_number AS phone_number', 'ppa.profile_id AS profile_id'])
        .getRawMany<{ phone_number: string; profile_id: string }>(),
    ]);

    const bizById = new Map(businesses.map((b) => [b.id, b]));
    const tenantById = new Map(tenants.map((t) => [t.id, t]));

    const phonesByProfile = new Map<string, string[]>();
    for (const r of ppaRows) {
      const arr = phonesByProfile.get(r.profile_id) ?? [];
      arr.push(r.phone_number);
      phonesByProfile.set(r.profile_id, arr);
    }
    const profilesByPhone = new Map<string, Set<string>>();
    for (const r of sharedRows) {
      const set = profilesByPhone.get(r.phone_number) ?? new Set();
      set.add(r.profile_id);
      profilesByPhone.set(r.phone_number, set);
    }

    const attribution = attributePlatforms(
      tenants.map<AttributionTenant>((t) => ({ id: t.id, name: t.name })),
    );

    return profiles.map((p) => {
      const phoneList = phonesByProfile.get(p.id) ?? [];
      const hasSharedPhone = phoneList.some(
        (n) => (profilesByPhone.get(n)?.size ?? 0) > 1,
      );
      return {
        id: p.id,
        displayName: p.displayName,
        slug: p.slug,
        source: String(p.source),
        status: String(p.status),
        isDefault: p.isDefault,
        externalProfileId: p.externalProfileId ?? null,
        communicationBusinessId: p.communicationBusinessId,
        businessName: bizById.get(p.communicationBusinessId)?.displayName ?? null,
        tenantId: p.tenantId,
        tenantName: tenantById.get(p.tenantId)?.name ?? null,
        workspaceId: p.workspaceId,
        platformId: attribution.byTenantId.get(p.tenantId) ?? 'unclassified',
        phoneCount: phoneList.length,
        hasSharedPhone,
        createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : String(p.createdAt),
      };
    });
  }

  private async buildPhoneRows(
    workspaceId: string,
    profiles: CommunicationProfile[],
  ): Promise<BusinessPhoneRow[]> {
    if (profiles.length === 0) return [];
    const profileIds = profiles.map((p) => p.id);

    const [bizPpa, allPpa] = await Promise.all([
      this.ppaRepo
        .createQueryBuilder('ppa')
        .innerJoin(TenantPhoneNumber, 'tpn', 'tpn.id = ppa.tenant_phone_number_id')
        .where('ppa.profile_id IN (:...ids)', { ids: profileIds })
        .andWhere('ppa.active = TRUE')
        .select([
          'ppa.profile_id AS profile_id',
          'tpn.id AS tpn_id',
          'tpn.phone_number AS phone_number',
          'tpn.provider AS provider',
          'tpn.a2p_status AS a2p_status',
        ])
        .getRawMany<{
          profile_id: string;
          tpn_id: string;
          phone_number: string;
          provider: string;
          a2p_status: string | null;
        }>(),
      this.ppaRepo
        .createQueryBuilder('ppa')
        .innerJoin(CommunicationProfile, 'p', 'p.id = ppa.profile_id')
        .innerJoin(TenantPhoneNumber, 'tpn', 'tpn.id = ppa.tenant_phone_number_id')
        .where('p.workspace_id = :ws', { ws: workspaceId })
        .andWhere('ppa.active = TRUE')
        .select(['tpn.phone_number AS phone_number', 'ppa.profile_id AS profile_id'])
        .getRawMany<{ phone_number: string; profile_id: string }>(),
    ]);

    const profilesByPhoneAll = new Map<string, Set<string>>();
    for (const r of allPpa) {
      const set = profilesByPhoneAll.get(r.phone_number) ?? new Set();
      set.add(r.profile_id);
      profilesByPhoneAll.set(r.phone_number, set);
    }

    const byPhone = new Map<string, BusinessPhoneRow>();
    for (const r of bizPpa) {
      const existing = byPhone.get(r.phone_number);
      if (existing) {
        existing.assignedProfileIds.push(r.profile_id);
      } else {
        byPhone.set(r.phone_number, {
          tenantPhoneNumberId: r.tpn_id,
          phoneNumber: r.phone_number,
          provider: r.provider,
          a2pStatus: r.a2p_status,
          assignedProfileIds: [r.profile_id],
          isShared: (profilesByPhoneAll.get(r.phone_number)?.size ?? 0) > 1,
        });
      }
    }

    return Array.from(byPhone.values()).sort((a, b) =>
      a.phoneNumber.localeCompare(b.phoneNumber),
    );
  }
}
