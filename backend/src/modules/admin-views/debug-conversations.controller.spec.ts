import { DebugConversationsController } from './debug-conversations.controller';
import { BadRequestException } from '@nestjs/common';

/**
 * Contract test for the #47 diagnostic endpoint. The endpoint's whole
 * reason for existing is decomposing "why can't tenant X see
 * conversation Y" into two aggregations — byTenant + byPhoneNumber —
 * so pin the response shape here. The SQL correctness itself is
 * verified live in prod once the route-by-phone read fix lands in the
 * same PR.
 */
describe('DebugConversationsController', () => {
  function buildController(overrides: { count?: number; byTenant?: unknown[]; byPhone?: unknown[] } = {}) {
    const byTenantQb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(overrides.byTenant ?? []),
    };
    const byPhoneQb = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(overrides.byPhone ?? []),
    };
    const conversationRepo: any = {
      count: jest.fn().mockResolvedValue(overrides.count ?? 0),
      createQueryBuilder: jest
        .fn()
        // First call is byTenant, second is byPhoneNumber — matches source order.
        .mockReturnValueOnce(byTenantQb)
        .mockReturnValueOnce(byPhoneQb),
    };
    const controller = new DebugConversationsController(conversationRepo);
    return { controller, conversationRepo, byTenantQb, byPhoneQb };
  }

  it('rejects when neither the caller nor the query has a workspaceId', async () => {
    const { controller } = buildController();
    await expect(controller.tenantDistribution('', undefined)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('falls back to the caller workspace when the query param is omitted', async () => {
    const { controller, conversationRepo } = buildController({ count: 42 });
    const out = await controller.tenantDistribution('ws-caller', undefined);
    expect(out.workspaceId).toBe('ws-caller');
    expect(out.totalConversations).toBe(42);
    expect(conversationRepo.count).toHaveBeenCalledWith({ where: { workspaceId: 'ws-caller' } });
  });

  it('prefers the explicit ?workspaceId param over the caller workspace (admin flow)', async () => {
    const { controller, conversationRepo } = buildController();
    await controller.tenantDistribution('ws-caller', 'ws-target');
    expect(conversationRepo.count).toHaveBeenCalledWith({ where: { workspaceId: 'ws-target' } });
  });

  it('maps grouped raw rows into byTenant + byPhoneNumber buckets', async () => {
    const { controller } = buildController({
      count: 5926,
      byTenant: [
        {
          tenant_id: 'tenant-jax',
          conversation_count: 455,
          distinct_phone_numbers: 2,
          sample_phone_numbers: ['+18139212100', '+19045778584'],
        },
        {
          tenant_id: 'tenant-sibling',
          conversation_count: 2619,
          distinct_phone_numbers: 1,
          sample_phone_numbers: ['+18139212103'],
        },
        {
          tenant_id: null,
          conversation_count: 2852,
          distinct_phone_numbers: 3,
          sample_phone_numbers: [null, '+18139212103', '+19045778584'],
        },
      ],
      byPhone: [
        { phone_number: '+18139212100', conversation_count: 300, distinct_tenant_ids: 1 },
        { phone_number: '+19045778584', conversation_count: 155, distinct_tenant_ids: 2 },
        { phone_number: null, conversation_count: 500, distinct_tenant_ids: 1 },
      ],
    });

    const out = await controller.tenantDistribution('ws-caller', 'ws-target');
    expect(out.totalConversations).toBe(5926);
    // Grouping preserved, order preserved (Postgres returns by count DESC).
    expect(out.byTenant.map((r) => r.tenantId)).toEqual(['tenant-jax', 'tenant-sibling', null]);
    expect(out.byTenant[0]).toEqual({
      tenantId: 'tenant-jax',
      conversationCount: 455,
      distinctPhoneNumbers: 2,
      samplePhoneNumbers: ['+18139212100', '+19045778584'],
    });
    // Null-valued sample phones are filtered out so the response shape stays typed.
    expect(out.byTenant[2].samplePhoneNumbers).toEqual(['+18139212103', '+19045778584']);
    // Phone bucket surfaces cross-tenant sharing (2 tenant_ids on the shared sender).
    expect(out.byPhoneNumber.find((r) => r.phoneNumber === '+19045778584')?.distinctTenantIds).toBe(2);
    // NULL phone_number bucket is included — it's the "no business phone, can't route" set.
    expect(out.byPhoneNumber.find((r) => r.phoneNumber === null)?.conversationCount).toBe(500);
  });
});
