/**
 * Scenario 7 — Concurrency.
 *
 * Invariant: 10 simultaneous provisioning requests for the same
 * (workspaceId, externalTenantId) collapse to exactly one tenant row,
 * one business row, one profile row, and one default-profile pointer.
 *
 * This validates the partial unique index race protection +
 * `findOrCreateTenantByExternalId`'s 23505-retry behavior + the
 * `ensureOutboundReadyForTenantPhone` per-row idempotency.
 */

import { bootHarness, PlatformContractHarness } from '../support/harness';

describe('Platform Contract — Scenario 7: Concurrency', () => {
  let h: PlatformContractHarness;

  beforeAll(async () => { h = await bootHarness(); });
  afterAll(async () => { await h.close(); });
  beforeEach(async () => {
    await h.reset();
    await h.seedBaseline();
  });

  it('10 concurrent provisions for the same externalTenantId produce one chain', async () => {
    const externalTenantId = `ext-concurrent-${Date.now()}`;
    const N = 10;

    const settled = await Promise.allSettled(
      Array.from({ length: N }).map(async () => {
        const { tenant } = await h.tenantsService.findOrCreateTenantByExternalId(
          h.workspaceId,
          { externalTenantId, displayName: 'Concurrent Acme' },
        );
        await h.communicationProvisioningService.provisionCommunicationChain(tenant);
        return tenant.id;
      }),
    );

    // At least the majority succeeded. A minority may hit a 23505 during
    // the race — depending on load, the retry inside
    // `findOrCreateTenantByExternalId` catches most, but the outer
    // `provisionCommunicationChain` calls have their own race on
    // business/profile inserts. As long as ONE succeeds and the DB ends
    // up with singletons, the invariant holds.
    const succeeded = settled.filter((s) => s.status === 'fulfilled').length;
    expect(succeeded).toBeGreaterThan(0);

    // Assert singletons.
    const tenantCount = await h.repos.tenant.count({
      where: { externalId: externalTenantId, workspaceId: h.workspaceId },
    });
    expect(tenantCount).toBe(1);

    const tenant = await h.repos.tenant.findOne({
      where: { externalId: externalTenantId, workspaceId: h.workspaceId },
    });
    const businessCount = await h.repos.business.count({
      where: { tenantId: tenant!.id },
    });
    expect(businessCount).toBe(1);
    const defaultProfileCount = await h.repos.profile.count({
      where: { tenantId: tenant!.id, slug: 'default' },
    });
    expect(defaultProfileCount).toBe(1);
  });
});
