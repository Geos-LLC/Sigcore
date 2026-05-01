import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { CommunicationBusiness } from '../../database/entities/communication-business.entity';
import { CommunicationProfile } from '../../database/entities/communication-profile.entity';
import { ProfilePhoneAssignment } from '../../database/entities/profile-phone-assignment.entity';
import { TenantPhoneNumber } from '../../database/entities/tenant-phone-number.entity';
import { Tenant } from '../../database/entities/tenant.entity';
import { CommunicationConversation } from '../../database/entities/communication-conversation.entity';
import { CommunicationMessage } from '../../database/entities/communication-message.entity';
import {
  attributePlatforms,
  AttributionTenant,
} from './platform-attribution';
import {
  ProfileSummary,
  ProfileDetail,
  ProfilePhoneAssignmentRow,
  ProfileRecentMessageRow,
} from './dto/admin-views.types';

export interface ProfileFilters {
  platformId?: string;
  source?: string;
  businessId?: string;
  tenantId?: string;
  hasPhones?: boolean;
  hasSharedPhone?: boolean;
  hasExternalId?: boolean;
  isDefault?: boolean;
}

const RECENT_MESSAGES_LIMIT = 20;

@Injectable()
export class ProfilesService {
  constructor(
    @InjectRepository(CommunicationProfile)
    private readonly profileRepo: Repository<CommunicationProfile>,
    @InjectRepository(CommunicationBusiness)
    private readonly bizRepo: Repository<CommunicationBusiness>,
    @InjectRepository(ProfilePhoneAssignment)
    private readonly ppaRepo: Repository<ProfilePhoneAssignment>,
    @InjectRepository(TenantPhoneNumber)
    private readonly tpnRepo: Repository<TenantPhoneNumber>,
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    @InjectRepository(CommunicationConversation)
    private readonly conversationRepo: Repository<CommunicationConversation>,
    @InjectRepository(CommunicationMessage)
    private readonly messageRepo: Repository<CommunicationMessage>,
  ) {}

  async list(workspaceId: string, filters: ProfileFilters = {}): Promise<ProfileSummary[]> {
    const profiles = await this.profileRepo.find({ where: { workspaceId } });
    if (profiles.length === 0) return [];
    const summaries = await this.buildSummaries(workspaceId, profiles);
    return this.applyFilters(summaries, filters);
  }

  async get(workspaceId: string, id: string): Promise<ProfileDetail> {
    const profile = await this.profileRepo.findOne({ where: { id, workspaceId } });
    if (!profile) throw new NotFoundException(`Profile ${id} not found`);

    const [summary] = await this.buildSummaries(workspaceId, [profile]);
    const assignments = await this.buildAssignmentRows(workspaceId, profile);
    const recentMessages = await this.buildRecentMessages(profile.id);

    return { ...summary, assignments, recentMessages };
  }

  // ---------------- helpers ----------------

  private async buildSummaries(
    workspaceId: string,
    profiles: CommunicationProfile[],
  ): Promise<ProfileSummary[]> {
    if (profiles.length === 0) return [];
    const businessIds = Array.from(new Set(profiles.map((p) => p.communicationBusinessId)));
    const tenantIds = Array.from(new Set(profiles.map((p) => p.tenantId)));
    const profileIds = profiles.map((p) => p.id);

    const [businesses, tenants, ppaRows, allWorkspacePpa] = await Promise.all([
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
    for (const r of allWorkspacePpa) {
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

  private applyFilters(rows: ProfileSummary[], f: ProfileFilters): ProfileSummary[] {
    return rows.filter((r) => {
      if (f.platformId && r.platformId !== f.platformId) return false;
      if (f.source && r.source !== f.source) return false;
      if (f.businessId && r.communicationBusinessId !== f.businessId) return false;
      if (f.tenantId && r.tenantId !== f.tenantId) return false;
      if (f.hasPhones && r.phoneCount === 0) return false;
      if (f.hasSharedPhone && !r.hasSharedPhone) return false;
      if (f.hasExternalId && !r.externalProfileId) return false;
      if (f.isDefault !== undefined && r.isDefault !== f.isDefault) return false;
      return true;
    });
  }

  private async buildAssignmentRows(
    workspaceId: string,
    profile: CommunicationProfile,
  ): Promise<ProfilePhoneAssignmentRow[]> {
    const rows = await this.ppaRepo
      .createQueryBuilder('ppa')
      .innerJoin(TenantPhoneNumber, 'tpn', 'tpn.id = ppa.tenant_phone_number_id')
      .where('ppa.profile_id = :pid', { pid: profile.id })
      .select([
        'ppa.id AS id',
        'ppa.role AS role',
        'ppa.is_default AS is_default',
        'ppa.priority AS priority',
        'ppa.active AS active',
        'tpn.id AS tpn_id',
        'tpn.phone_number AS phone_number',
        'tpn.provider AS provider',
      ])
      .orderBy('ppa.is_default', 'DESC')
      .addOrderBy('ppa.priority', 'DESC')
      .getRawMany<{
        id: string;
        role: string;
        is_default: boolean;
        priority: number;
        active: boolean;
        tpn_id: string;
        phone_number: string;
        provider: string;
      }>();

    if (rows.length === 0) return [];

    // Detect shared phones across the workspace
    const phoneNumbers = rows.map((r) => r.phone_number);
    const sharedRows = await this.ppaRepo
      .createQueryBuilder('ppa')
      .innerJoin(CommunicationProfile, 'p', 'p.id = ppa.profile_id')
      .innerJoin(TenantPhoneNumber, 'tpn', 'tpn.id = ppa.tenant_phone_number_id')
      .where('p.workspace_id = :ws', { ws: workspaceId })
      .andWhere('tpn.phone_number IN (:...nums)', { nums: phoneNumbers })
      .andWhere('ppa.active = TRUE')
      .select([
        'tpn.phone_number AS phone_number',
        'ppa.profile_id AS profile_id',
        'p.display_name AS profile_name',
      ])
      .getRawMany<{ phone_number: string; profile_id: string; profile_name: string }>();

    const sharedByPhone = new Map<string, Array<{ profileId: string; profileName: string }>>();
    for (const r of sharedRows) {
      if (r.profile_id === profile.id) continue;
      const arr = sharedByPhone.get(r.phone_number) ?? [];
      arr.push({ profileId: r.profile_id, profileName: r.profile_name });
      sharedByPhone.set(r.phone_number, arr);
    }

    return rows.map((r) => ({
      id: r.id,
      tenantPhoneNumberId: r.tpn_id,
      phoneNumber: r.phone_number,
      provider: r.provider,
      role: r.role,
      isDefault: r.is_default,
      priority: r.priority,
      active: r.active,
      isShared: (sharedByPhone.get(r.phone_number)?.length ?? 0) > 0,
      sharedWith: sharedByPhone.get(r.phone_number) ?? [],
    }));
  }

  private async buildRecentMessages(profileId: string): Promise<ProfileRecentMessageRow[]> {
    const rows = await this.messageRepo
      .createQueryBuilder('m')
      .innerJoin(CommunicationConversation, 'c', 'c.id = m.conversation_id')
      .where('c.communication_profile_id = :pid', { pid: profileId })
      .orderBy('m.created_at', 'DESC')
      .limit(RECENT_MESSAGES_LIMIT)
      .select([
        'm.id AS id',
        'm.conversation_id AS conversation_id',
        'm.direction AS direction',
        'm.from_number AS from_number',
        'm.to_number AS to_number',
        'm.body AS body',
        'm.status AS status',
        'm.created_at AS created_at',
      ])
      .getRawMany<{
        id: string;
        conversation_id: string;
        direction: string;
        from_number: string;
        to_number: string;
        body: string;
        status: string;
        created_at: Date | string;
      }>();

    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      direction: r.direction,
      fromNumber: r.from_number,
      toNumber: r.to_number,
      body: r.body,
      status: r.status,
      createdAt:
        r.created_at instanceof Date
          ? r.created_at.toISOString()
          : new Date(r.created_at).toISOString(),
    }));
  }
}
