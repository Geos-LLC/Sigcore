import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Tenant } from '../../database/entities/tenant.entity';
import { TenantPhoneNumber } from '../../database/entities/tenant-phone-number.entity';
import { ApiKey } from '../../database/entities/api-key.entity';
import { WebhookSubscription } from '../../database/entities/webhook-subscription.entity';
import { CommunicationConversation } from '../../database/entities/communication-conversation.entity';
import { CommunicationMessage } from '../../database/entities/communication-message.entity';
import {
  attributePlatforms,
  tenantsByPlatform,
  PLATFORM_ANCHORS,
  PLATFORM_DISPLAY_NAMES,
  AttributionResult,
} from './platform-attribution';
import {
  PlatformId,
  PlatformSummary,
  PlatformDetail,
  PlatformWorkspaceRow,
  PlatformPhoneRow,
  PlatformApiKeyRow,
  PlatformWebhookRow,
} from './dto/admin-views.types';

const ALL_PLATFORM_IDS: PlatformId[] = [
  'leadbridge',
  'hirefunnel',
  'serviceflow',
  'callio',
  'unclassified',
];

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
  ) {}

  /**
   * List all platforms (always 5 rows: 4 known + unclassified) with rolled-up
   * counts scoped to the calling workspace.
   */
  async listPlatforms(workspaceId: string): Promise<PlatformSummary[]> {
    const attribution = await this.getAttribution(workspaceId);
    const grouped = tenantsByPlatform(attribution);

    const summaries: PlatformSummary[] = [];
    for (const id of ALL_PLATFORM_IDS) {
      const tenantIds = grouped[id];
      summaries.push(await this.buildSummary(id, workspaceId, tenantIds, attribution));
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

    const attribution = await this.getAttribution(workspaceId);
    const grouped = tenantsByPlatform(attribution);
    const tenantIds = grouped[id];

    const summary = await this.buildSummary(id, workspaceId, tenantIds, attribution);

    if (tenantIds.length === 0) {
      return {
        ...summary,
        workspaces: [],
        phoneNumbers: [],
        apiKeys: [],
        webhooks: [],
      };
    }

    const [tenants, phones, apiKeys, webhooks] = await Promise.all([
      this.tenantRepo.find({ where: { workspaceId, id: In(tenantIds) } }),
      this.phoneRepo.find({ where: { workspaceId, tenantId: In(tenantIds) } }),
      this.apiKeyRepo.find({ where: { workspaceId, tenantId: In(tenantIds) } }),
      this.webhookRepo.find({ where: { workspaceId, tenantId: In(tenantIds) } }),
    ]);

    const tenantNameById = new Map<string, string>(tenants.map((t) => [t.id, t.name]));

    const workspaceRows: PlatformWorkspaceRow[] = tenants
      .map((t) => ({
        id: t.id,
        name: t.name,
        status: String(t.status),
        createdAt: t.createdAt instanceof Date ? t.createdAt.toISOString() : String(t.createdAt),
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

    return {
      ...summary,
      workspaces: workspaceRows,
      phoneNumbers: phoneRows,
      apiKeys: apiKeyRows,
      webhooks: webhookRows,
    };
  }

  /**
   * Cached-per-call attribution: load every tenant for the workspace once and
   * pass the same result to both list and detail builders.
   */
  private async getAttribution(workspaceId: string): Promise<AttributionResult> {
    const tenants = await this.tenantRepo.find({
      where: { workspaceId },
      select: ['id', 'name'],
    });
    return attributePlatforms(tenants);
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

// re-export for callers
export { PLATFORM_ANCHORS };
