import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Tenant } from '../../database/entities/tenant.entity';
import { TenantPhoneNumber } from '../../database/entities/tenant-phone-number.entity';
import { ApiKey } from '../../database/entities/api-key.entity';
import { WebhookSubscription } from '../../database/entities/webhook-subscription.entity';
import { CommunicationConversation } from '../../database/entities/communication-conversation.entity';
import { CommunicationMessage } from '../../database/entities/communication-message.entity';
import { ProductWorkspace } from '../../database/entities/product-workspace.entity';
import { Business } from '../../database/entities/business.entity';
import { PhoneNumberAssignment } from '../../database/entities/phone-number-assignment.entity';
import { CommunicationBusiness } from '../../database/entities/communication-business.entity';
import { CommunicationProfile } from '../../database/entities/communication-profile.entity';
import { ProfilePhoneAssignment } from '../../database/entities/profile-phone-assignment.entity';
import {
  attributePlatforms,
  tenantsByPlatform,
  PLATFORM_ANCHORS,
  PLATFORM_DISPLAY_NAMES,
  AttributionResult,
  AttributionTenant,
} from './platform-attribution';
import {
  groupWorkspaces,
  GroupingTenant,
  GroupingBusiness,
} from './workspace-grouping';
import {
  PlatformId,
  PlatformSummary,
  PlatformDetail,
  PlatformWorkspaceRow,
  PlatformPhoneRow,
  PlatformApiKeyRow,
  PlatformWebhookRow,
  WorkspaceGroup,
  ProfileRow,
} from './dto/admin-views.types';

const ALL_PLATFORM_IDS: PlatformId[] = [
  'leadbridge',
  'hirefunnel',
  'serviceflow',
  'callio',
  'unclassified',
];

interface SignalBundle {
  attribution: AttributionResult;
  tenants: Tenant[];
}

@Injectable()
export class PlatformsService {
  private readonly logger = new Logger(PlatformsService.name);

  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepo: Repository<Tenant>,
    @InjectRepository(TenantPhoneNumber)
    private readonly phoneRepo: Repository<TenantPhoneNumber>,
    @InjectRepository(ApiKey)
    private readonly apiKeyRepo: Repository<ApiKey>,
    @InjectRepository(WebhookSubscription)
    private readonly webhookRepo: Repository<WebhookSubscription>,
    @InjectRepository(CommunicationConversation)
    private readonly conversationRepo: Repository<CommunicationConversation>,
    @InjectRepository(CommunicationMessage)
    private readonly messageRepo: Repository<CommunicationMessage>,
    @InjectRepository(ProductWorkspace)
    private readonly productWorkspaceRepo: Repository<ProductWorkspace>,
    @InjectRepository(Business)
    private readonly businessRepo: Repository<Business>,
    @InjectRepository(PhoneNumberAssignment)
    private readonly pnaRepo: Repository<PhoneNumberAssignment>,
    @InjectRepository(CommunicationBusiness)
    private readonly commBizRepo: Repository<CommunicationBusiness>,
    @InjectRepository(CommunicationProfile)
    private readonly commProfileRepo: Repository<CommunicationProfile>,
    @InjectRepository(ProfilePhoneAssignment)
    private readonly ppaRepo: Repository<ProfilePhoneAssignment>,
  ) {}

  /**
   * List all platforms (always 5 rows: 4 known + unclassified) with rolled-up
   * counts scoped to the calling workspace.
   */
  async listPlatforms(workspaceId: string): Promise<PlatformSummary[]> {
    const bundle = await this.loadSignals(workspaceId);
    const grouped = tenantsByPlatform(bundle.attribution);

    const summaries: PlatformSummary[] = [];
    for (const id of ALL_PLATFORM_IDS) {
      summaries.push(await this.buildSummary(id, workspaceId, grouped[id], bundle.attribution));
    }
    return summaries;
  }

  /**
   * Detailed view of a single platform, including child workspaces, phone
   * numbers, api keys and webhook subscriptions.
   */
  async getPlatform(
    workspaceId: string,
    platformId: string,
  ): Promise<PlatformDetail> {
    if (!ALL_PLATFORM_IDS.includes(platformId as PlatformId)) {
      throw new NotFoundException(`Unknown platform: ${platformId}`);
    }
    const id = platformId as PlatformId;

    const bundle = await this.loadSignals(workspaceId);
    const grouped = tenantsByPlatform(bundle.attribution);
    const tenantIds = grouped[id];

    const summary = await this.buildSummary(id, workspaceId, tenantIds, bundle.attribution);

    if (tenantIds.length === 0) {
      return {
        ...summary,
        workspaces: [],
        workspaceGroups: [],
        phoneNumbers: [],
        apiKeys: [],
        webhooks: [],
      };
    }

    const [phones, apiKeys, webhooks, legacyAssignments] = await Promise.all([
      this.phoneRepo.find({ where: { workspaceId, tenantId: In(tenantIds) } }),
      this.apiKeyRepo.find({ where: { workspaceId, tenantId: In(tenantIds) } }),
      this.webhookRepo.find({ where: { workspaceId, tenantId: In(tenantIds) } }),
      this.pnaRepo
        .createQueryBuilder('p')
        .where('p.business_id IN (:...tenantIds)', { tenantIds })
        .getMany(),
    ]);

    const tenantNameById = new Map<string, string>(
      bundle.tenants.map((t) => [t.id, t.name]),
    );
    const tenantById = new Map<string, Tenant>(
      bundle.tenants.map((t) => [t.id, t]),
    );

    const workspaceRows: PlatformWorkspaceRow[] = tenantIds
      .map((tid) => tenantById.get(tid))
      .filter((t): t is Tenant => Boolean(t))
      .map((t) => ({
        id: t.id,
        name: t.name,
        status: String(t.status),
        createdAt: t.createdAt instanceof Date ? t.createdAt.toISOString() : String(t.createdAt),
        attributionReason:
          bundle.attribution.reasonByTenantId.get(t.id) ?? 'unclassified',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const phoneRows: PlatformPhoneRow[] = phones
      .map((p) => ({
        id: p.id,
        phoneNumber: p.phoneNumber,
        provider: String(p.provider),
        a2pStatus: p.a2pStatus ?? null,
        tenantId: p.tenantId,
        tenantName: tenantNameById.get(p.tenantId) ?? null,
      }))
      .sort((a, b) => a.phoneNumber.localeCompare(b.phoneNumber));

    const apiKeyRows: PlatformApiKeyRow[] = apiKeys
      .map((k) => ({
        id: k.id,
        name: k.name,
        scope: k.scope,
        tenantId: k.tenantId,
        tenantName: k.tenantId ? tenantNameById.get(k.tenantId) ?? null : null,
        lastUsedAt:
          k.lastUsedAt instanceof Date ? k.lastUsedAt.toISOString() : k.lastUsedAt ?? null,
        active: k.active,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const webhookRows: PlatformWebhookRow[] = webhooks
      .map((w) => ({
        id: w.id,
        name: w.name,
        webhookUrl: w.webhookUrl,
        events: Array.isArray(w.events) ? (w.events as unknown as string[]) : [],
        status: String(w.status),
        tenantId: w.tenantId ?? null,
        tenantName: w.tenantId ? tenantNameById.get(w.tenantId) ?? null : null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Build the customer-workspace tree (business_identity → name prefix → standalone).
    const workspaceGroups = await this.buildWorkspaceGroups({
      tenantIds,
      tenantById,
      attribution: bundle.attribution,
      phones,
      legacyAssignments,
    });

    return {
      ...summary,
      workspaces: workspaceRows,
      workspaceGroups,
      phoneNumbers: phoneRows,
      apiKeys: apiKeyRows,
      webhooks: webhookRows,
    };
  }

  /**
   * Build the platform's customer-workspace tree.
   *
   * PR2 — primary path: real `communication_businesses` + `communication_profiles`
   *   + `profile_phone_assignments`. Each business produces one WorkspaceGroup;
   *   each profile is sourced from its real DB row with stable IDs and
   *   `source` populated from `communication_profiles.source`.
   *
   * Fallback path: name-prefix derivation via `groupWorkspaces`. Only fires
   *   for tenants with no real `communication_businesses` row — shouldn't
   *   happen post-PR1 backfill, but kept for safety.
   */
  private async buildWorkspaceGroups(input: {
    tenantIds: string[];
    tenantById: Map<string, Tenant>;
    attribution: AttributionResult;
    phones: TenantPhoneNumber[];
    legacyAssignments: PhoneNumberAssignment[];
  }): Promise<WorkspaceGroup[]> {
    const { tenantIds, tenantById, attribution, phones, legacyAssignments } = input;
    if (tenantIds.length === 0) return [];

    // ---------- Real path: load communication_businesses + profiles + assignments ----------
    const commBusinesses = await this.commBizRepo.find({
      where: { tenantId: In(tenantIds) },
    });
    const commBusinessIds = commBusinesses.map((b) => b.id);

    const commProfiles =
      commBusinessIds.length > 0
        ? await this.commProfileRepo.find({
            where: { communicationBusinessId: In(commBusinessIds) },
          })
        : [];
    const commProfileIds = commProfiles.map((p) => p.id);

    // Phone count per profile via the M:N junction (active rows only).
    const ppaRows: Array<{ profile_id: string; phone_number: string }> =
      commProfileIds.length > 0
        ? await this.ppaRepo
            .createQueryBuilder('ppa')
            .innerJoin(
              TenantPhoneNumber,
              'tpn',
              'tpn.id = ppa.tenant_phone_number_id',
            )
            .where('ppa.profile_id IN (:...ids)', { ids: commProfileIds })
            .andWhere('ppa.active = TRUE')
            .select([
              'ppa.profile_id AS profile_id',
              'tpn.phone_number AS phone_number',
            ])
            .getRawMany()
        : [];

    const profilesByBusinessId = new Map<string, CommunicationProfile[]>();
    for (const p of commProfiles) {
      const arr = profilesByBusinessId.get(p.communicationBusinessId) ?? [];
      arr.push(p);
      profilesByBusinessId.set(p.communicationBusinessId, arr);
    }

    const phonesByProfileId = new Map<string, string[]>();
    for (const r of ppaRows) {
      const arr = phonesByProfileId.get(r.profile_id) ?? [];
      arr.push(r.phone_number);
      phonesByProfileId.set(r.profile_id, arr);
    }

    // Per-tenant legacy presence (phone_number_assignments where business_id = tenant.id).
    const legacyByTenant = new Set<string>();
    for (const a of legacyAssignments) {
      if (a.businessId) legacyByTenant.add(a.businessId);
    }

    const realGroups: WorkspaceGroup[] = [];
    const tenantsWithRealBiz = new Set<string>();

    for (const biz of commBusinesses) {
      tenantsWithRealBiz.add(biz.tenantId);
      const tenant = tenantById.get(biz.tenantId);
      const tenantHasLegacy = legacyByTenant.has(biz.tenantId);

      const profileRows: ProfileRow[] = (profilesByBusinessId.get(biz.id) ?? []).map(
        (p) => {
          const phones = phonesByProfileId.get(p.id) ?? [];
          return {
            name: p.displayName,
            duplicateCount: 1,
            tenantIds: [biz.tenantId],
            phoneNumbersCount: phones.length,
            hasCurrent: phones.length > 0,
            hasLegacy: tenantHasLegacy,
            attributionReasons: [String(p.source)],
            communicationProfileId: p.id,
            source: String(p.source),
            externalProfileId: p.externalProfileId ?? null,
            slug: p.slug,
          };
        },
      );

      // Sort profiles: default first, then alphabetical.
      profileRows.sort((a, b) => {
        const aDefault = (profilesByBusinessId.get(biz.id) ?? []).find(
          (p) => p.id === a.communicationProfileId,
        )?.isDefault
          ? 0
          : 1;
        const bDefault = (profilesByBusinessId.get(biz.id) ?? []).find(
          (p) => p.id === b.communicationProfileId,
        )?.isDefault
          ? 0
          : 1;
        if (aDefault !== bDefault) return aDefault - bDefault;
        return a.name.localeCompare(b.name);
      });

      const totalPhones = profileRows.reduce(
        (acc, p) => acc + p.phoneNumbersCount,
        0,
      );
      const attributionReasons = uniqueStable(
        profileRows.flatMap((p) => p.attributionReasons),
      );

      realGroups.push({
        name: biz.displayName,
        source: 'business_identity',
        businessIdentityId: tenant?.businessIdentityId ?? null,
        profiles: profileRows,
        profileCount: profileRows.length,
        totalTenantCount: 1,
        totalPhoneNumbersCount: totalPhones,
        attributionReasons,
        communicationBusinessId: biz.id,
        externalBusinessId: biz.externalBusinessId ?? null,
        tenantId: biz.tenantId,
        tenantName: tenant?.name ?? null,
      });
    }

    // ---------- Fallback path: tenants with no real business → derivation ----------
    const orphanTenantIds = tenantIds.filter((tid) => !tenantsWithRealBiz.has(tid));
    if (orphanTenantIds.length > 0) {
      this.logger.warn(
        `[admin-views] ${orphanTenantIds.length} tenants without communication_businesses — using legacy derivation fallback`,
      );

      const phoneCountByTenant = new Map<string, number>();
      for (const p of phones) {
        if (orphanTenantIds.includes(p.tenantId)) {
          phoneCountByTenant.set(
            p.tenantId,
            (phoneCountByTenant.get(p.tenantId) ?? 0) + 1,
          );
        }
      }

      const groupingTenants: GroupingTenant[] = orphanTenantIds
        .map((tid) => tenantById.get(tid))
        .filter((t): t is Tenant => Boolean(t))
        .map((t) => {
          const c = phoneCountByTenant.get(t.id) ?? 0;
          return {
            id: t.id,
            name: t.name,
            businessIdentityId: t.businessIdentityId ?? null,
            attributionReason:
              attribution.reasonByTenantId.get(t.id) ?? 'unclassified',
            phoneNumbersCount: c,
            hasLegacy: legacyByTenant.has(t.id),
            hasCurrent: c > 0,
          };
        });

      // businesses lookup for the OLD identity registry — only used by
      // legacy derivation. Different table from communication_businesses.
      const orphanBusinessIds = Array.from(
        new Set(
          orphanTenantIds
            .map((tid) => tenantById.get(tid)?.businessIdentityId)
            .filter((bid): bid is string => Boolean(bid)),
        ),
      );
      const oldBusinesses =
        orphanBusinessIds.length > 0
          ? await this.businessRepo.find({ where: { id: In(orphanBusinessIds) } })
          : [];
      const businessesById = new Map<string, GroupingBusiness>(
        oldBusinesses.map((b) => [b.id, { id: b.id, name: b.name }]),
      );

      const fallbackGroups = groupWorkspaces(groupingTenants, businessesById).groups;
      realGroups.push(...fallbackGroups);
    }

    return realGroups;
  }

  /**
   * Load every signal needed for attribution in a single bundle, in parallel:
   *   - tenants for the workspace
   *   - product_workspaces joined to those tenants (via tenants.product_workspace_id)
   *   - webhook_subscriptions for the workspace, indexed by tenant_id
   *   - api_keys for the workspace, indexed by tenant_id
   *
   * Joining product_workspaces in JS rather than SQL because tenants.product_workspace_id
   * is varchar in the DB while product_workspaces.id is uuid (uuid = varchar
   * type mismatch in raw SQL joins).
   */
  private async loadSignals(workspaceId: string): Promise<SignalBundle> {
    const tenants = await this.tenantRepo.find({
      where: { workspaceId },
    });

    const productWorkspaceIds = Array.from(
      new Set(
        tenants
          .map((t) => t.productWorkspaceId)
          .filter((id): id is string => Boolean(id)),
      ),
    );

    const [productWorkspaces, webhooks, apiKeys] = await Promise.all([
      productWorkspaceIds.length > 0
        ? this.productWorkspaceRepo.find({ where: { id: In(productWorkspaceIds) } })
        : Promise.resolve([] as ProductWorkspace[]),
      this.webhookRepo.find({ where: { workspaceId } }),
      this.apiKeyRepo.find({ where: { workspaceId } }),
    ]);

    const productTypeById = new Map<string, string>(
      productWorkspaces.map((pw) => [pw.id, String(pw.productType)]),
    );

    const webhookUrlsByTenantId = new Map<string, string[]>();
    for (const w of webhooks) {
      if (!w.tenantId || !w.webhookUrl) continue;
      const list = webhookUrlsByTenantId.get(w.tenantId) ?? [];
      list.push(w.webhookUrl);
      webhookUrlsByTenantId.set(w.tenantId, list);
    }

    const apiKeyNamesByTenantId = new Map<string, string[]>();
    for (const k of apiKeys) {
      if (!k.tenantId || !k.name) continue;
      const list = apiKeyNamesByTenantId.get(k.tenantId) ?? [];
      list.push(k.name);
      apiKeyNamesByTenantId.set(k.tenantId, list);
    }

    const attributionInput: AttributionTenant[] = tenants.map((t) => ({
      id: t.id,
      name: t.name,
      productWorkspaceProductType: t.productWorkspaceId
        ? productTypeById.get(t.productWorkspaceId) ?? null
        : null,
      webhookUrls: webhookUrlsByTenantId.get(t.id) ?? [],
      apiKeyNames: apiKeyNamesByTenantId.get(t.id) ?? [],
    }));

    const attribution = attributePlatforms(attributionInput);
    return { attribution, tenants };
  }

  private async buildSummary(
    id: PlatformId,
    workspaceId: string,
    tenantIds: string[],
    attribution: AttributionResult,
  ): Promise<PlatformSummary> {
    const anchorTenantId = id === 'unclassified' ? null : attribution.anchors[id];

    if (tenantIds.length === 0) {
      return {
        id,
        name: PLATFORM_DISPLAY_NAMES[id],
        anchorTenantId,
        workspaceCount: 0,
        apiKeyCount: 0,
        phoneNumberCount: 0,
        webhookSubscriptionCount: 0,
        lastActivityAt: null,
      };
    }

    const [phoneNumberCount, apiKeyCount, webhookSubscriptionCount, lastActivityAt] =
      await Promise.all([
        this.phoneRepo.count({ where: { workspaceId, tenantId: In(tenantIds) } }),
        this.apiKeyRepo.count({ where: { workspaceId, tenantId: In(tenantIds) } }),
        this.webhookRepo.count({ where: { workspaceId, tenantId: In(tenantIds) } }),
        this.findLastActivityAt(workspaceId, tenantIds),
      ]);

    return {
      id,
      name: PLATFORM_DISPLAY_NAMES[id],
      anchorTenantId,
      workspaceCount: tenantIds.length,
      apiKeyCount,
      phoneNumberCount,
      webhookSubscriptionCount,
      lastActivityAt,
    };
  }

  /**
   * communication_messages does NOT carry a tenant_id directly. Join through
   * communication_conversations to scope to the platform's tenants.
   */
  private async findLastActivityAt(
    workspaceId: string,
    tenantIds: string[],
  ): Promise<string | null> {
    if (tenantIds.length === 0) return null;
    try {
      const row = await this.messageRepo
        .createQueryBuilder('m')
        .select('MAX(m.created_at)', 'last')
        .innerJoin(
          CommunicationConversation,
          'c',
          'c.id = m.conversation_id',
        )
        .where('c.workspace_id = :workspaceId', { workspaceId })
        .andWhere('c.tenant_id IN (:...tenantIds)', { tenantIds })
        .getRawOne<{ last: Date | string | null }>();
      const last = row?.last ?? null;
      if (!last) return null;
      return last instanceof Date ? last.toISOString() : new Date(last).toISOString();
    } catch (e) {
      this.logger.warn(`findLastActivityAt failed for workspace=${workspaceId}: ${(e as Error).message}`);
      return null;
    }
  }
}

function uniqueStable<T>(arr: T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const x of arr) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

// re-export for callers
export { PLATFORM_ANCHORS };
