import {
  Controller,
  Get,
  Query,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SigcoreAuthGuard } from '../auth/sigcore-auth.guard';
import { WorkspaceId } from '../auth/decorators/workspace-id.decorator';
import { CommunicationConversation } from '../../database/entities/communication-conversation.entity';

/**
 * Diagnostic endpoint written to prove/disprove the tenant-id
 * mismatch hypothesis behind Sigcore #47 before shipping the
 * route-by-phone read fix in the same PR. Kept in the admin-views
 * module because the SigcoreAuthGuard's admin/service-key path is the
 * intended caller and there is no per-tenant risk (aggregate counts
 * only, no message content).
 *
 * Once the route-by-phone fix is validated in prod and #47 is closed,
 * this endpoint stays: any future "why can't a tenant see conversation
 * X" question is answered by the same shape.
 */

interface TenantBucket {
  tenantId: string | null;
  conversationCount: number;
  distinctPhoneNumbers: number;
  samplePhoneNumbers: string[];
}

interface PhoneBucket {
  phoneNumber: string | null;
  conversationCount: number;
  distinctTenantIds: number;
}

interface DistributionResponse {
  workspaceId: string;
  totalConversations: number;
  byTenant: TenantBucket[];
  byPhoneNumber: PhoneBucket[];
}

@Controller('admin/debug/conversations')
@UseGuards(SigcoreAuthGuard)
export class DebugConversationsController {
  constructor(
    @InjectRepository(CommunicationConversation)
    private readonly conversationRepo: Repository<CommunicationConversation>,
  ) {}

  /**
   * GET /admin/debug/conversations/tenant-distribution?workspaceId=...
   *
   * Returns two aggregations over `communication_conversations` for
   * the requested workspace:
   *
   *   byTenant       — one row per distinct tenant_id (NULL included),
   *                    with sample phone numbers. Answers "who owns
   *                    the conversations the caller can't see."
   *   byPhoneNumber  — one row per distinct phone_number (NULL/empty
   *                    included), with the distinct tenant_ids seen
   *                    on that phone. Answers "are there phones tagged
   *                    to multiple tenants" (shared-sender pattern).
   *
   * `workspaceId` param is REQUIRED even though the auth guard already
   * attaches one — this endpoint is designed to be run against an
   * arbitrary workspace by an admin key, and defaulting to the caller
   * would be surprising for that use case. If a non-admin caller omits
   * it, we fall back to their own workspaceId.
   */
  @Get('tenant-distribution')
  async tenantDistribution(
    @WorkspaceId() callerWorkspaceId: string,
    @Query('workspaceId') queryWorkspaceId?: string,
  ): Promise<DistributionResponse> {
    const workspaceId = queryWorkspaceId || callerWorkspaceId;
    if (!workspaceId) {
      throw new BadRequestException('workspaceId is required');
    }

    const total = await this.conversationRepo.count({ where: { workspaceId } });

    const byTenantRaw = await this.conversationRepo
      .createQueryBuilder('conv')
      .select('conv.tenant_id', 'tenant_id')
      .addSelect('COUNT(*)::int', 'conversation_count')
      .addSelect('COUNT(DISTINCT conv.phone_number)::int', 'distinct_phone_numbers')
      .addSelect(
        `(ARRAY(SELECT DISTINCT c2.phone_number FROM communication_conversations c2
                WHERE c2.workspace_id = conv.workspace_id
                  AND (c2.tenant_id = conv.tenant_id OR (c2.tenant_id IS NULL AND conv.tenant_id IS NULL))
                LIMIT 5))`,
        'sample_phone_numbers',
      )
      .where('conv.workspace_id = :workspaceId', { workspaceId })
      .groupBy('conv.tenant_id')
      .orderBy('COUNT(*)', 'DESC')
      .getRawMany<{
        tenant_id: string | null;
        conversation_count: number;
        distinct_phone_numbers: number;
        sample_phone_numbers: (string | null)[];
      }>();

    const byPhoneRaw = await this.conversationRepo
      .createQueryBuilder('conv')
      .select('conv.phone_number', 'phone_number')
      .addSelect('COUNT(*)::int', 'conversation_count')
      .addSelect('COUNT(DISTINCT conv.tenant_id)::int', 'distinct_tenant_ids')
      .where('conv.workspace_id = :workspaceId', { workspaceId })
      .groupBy('conv.phone_number')
      .orderBy('COUNT(*)', 'DESC')
      .limit(50)
      .getRawMany<{
        phone_number: string | null;
        conversation_count: number;
        distinct_tenant_ids: number;
      }>();

    return {
      workspaceId,
      totalConversations: total,
      byTenant: byTenantRaw.map((r) => ({
        tenantId: r.tenant_id,
        conversationCount: r.conversation_count,
        distinctPhoneNumbers: r.distinct_phone_numbers,
        samplePhoneNumbers: (r.sample_phone_numbers ?? []).filter(
          (p): p is string => !!p,
        ),
      })),
      byPhoneNumber: byPhoneRaw.map((r) => ({
        phoneNumber: r.phone_number,
        conversationCount: r.conversation_count,
        distinctTenantIds: r.distinct_tenant_ids,
      })),
    };
  }
}
