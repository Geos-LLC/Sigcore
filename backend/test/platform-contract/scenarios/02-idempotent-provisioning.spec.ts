/**
 * Scenario 2 — Idempotent Provisioning.
 *
 * Invariant: repeated `findOrCreateTenantByExternalId` +
 * `provisionCommunicationChain` calls with the same
 * (workspaceId, externalTenantId) produce exactly one tenant, one
 * business, one profile, and one default-profile pointer. No
 * duplicates ever, no matter how many times a caller retries.
 */

import { bootHarness, PlatformContractHarness } from '../support/harness';

describe('Platform Contract — Scenario 2: Idempotent Provisioning', () => {
  let h: PlatformContractHarness;

  beforeAll(async () => { h = await bootHarness(); });
  afterAll(async () => { await h.close(); });
  beforeEach(async () => {
    await h.reset();
    await h.seedBaseline();
  });

  it('re-provisioning the same externalTenantId N times returns the same tenant and one chain', async () => {
    const externalTenantId = `ext-idem-${Date.now()}`;
    const RUNS = 5;

    const results: string[] = [];
    for (let i = 0; i < RUNS; i++) {
      const { tenant } = await h.tenantsService.findOrCreateTenantByExternalId(
        h.workspaceId,
        { externalTenantId, displayName: 'Idempotent Acme' },
      );
      await h.communicationProvisioningService.provisionCommunicationChain(tenant);
      results.push(tenant.id);
    }

    // All N calls returned the same tenant id.
    expect(new Set(results).size).toBe(1);

    // Verify singletons at the DB level (query directly for assertion only,
    // per the "no direct DB inserts" rule — assertions are read-only).
    const tenantCount = await h.repos.tenant.count({
      where: { externalId: externalTenantId, workspaceId: h.workspaceId },
    });
    expect(tenantCount).toBe(1);

    const businessRows = await h.repos.business.find({
      where: { tenantId: results[0] },
    });
    expect(businessRows.length).toBe(1);

    const profileRows = await h.repos.profile.find({
      where: { tenantId: results[0], slug: 'default' },
    });
    expect(profileRows.length).toBe(1);

    // Exactly one profile has is_default=true.
    const defaults = profileRows.filter((p) => p.isDefault);
    expect(defaults.length).toBe(1);
  });
});
