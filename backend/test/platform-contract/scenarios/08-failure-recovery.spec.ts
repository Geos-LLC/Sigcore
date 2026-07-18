/**
 * Scenario 8 — Failure Recovery.
 *
 * Invariant: when provisioning is interrupted mid-chain, a retry
 * heals the missing links without producing orphan rows. The
 * post-recovery audit report must be clean.
 *
 * Injection strategy: swap `businessRepo.save` to throw once, then
 * restore the original method. First call fails (business created but
 * profile insert throws); second call idempotently continues from
 * partial state (business found, profile inserted, PPA inserted, TPN
 * stamped).
 *
 * The idempotency of `ensureOutboundReadyForTenantPhone` + the
 * assertion-only integration path + the TPN stamping helper's
 * "swallow-and-log" semantics on the purchase side make this recovery
 * work by construction.
 */

import { bootHarness, PlatformContractHarness } from '../support/harness';

describe('Platform Contract — Scenario 8: Failure Recovery', () => {
  let h: PlatformContractHarness;

  beforeAll(async () => { h = await bootHarness(); });
  afterAll(async () => { await h.close(); });
  beforeEach(async () => {
    await h.reset();
    await h.seedBaseline();
  });

  it('partial-provisioning failure followed by retry leaves no orphans', async () => {
    const externalTenantId = `ext-fail-${Date.now()}`;
    const { tenant } = await h.tenantsService.findOrCreateTenantByExternalId(
      h.workspaceId,
      { externalTenantId, displayName: 'Failure Recovery' },
    );

    // Inject a one-shot failure into profile.save so the first
    // provisionCommunicationChain call blows up AFTER the business is
    // written but BEFORE the profile is written.
    const originalSave = h.repos.profile.save.bind(h.repos.profile);
    let calls = 0;
    (h.repos.profile as any).save = jest.fn(async (v: any) => {
      calls += 1;
      if (calls === 1) throw new Error('simulated transient DB failure');
      return originalSave(v);
    });

    await expect(
      h.communicationProvisioningService.provisionCommunicationChain(tenant),
    ).rejects.toThrow('simulated transient DB failure');

    // At this point:
    //   - business row exists (written before the throw)
    //   - profile row does NOT exist
    //   - no orphan PPA, no orphan TPN
    const businessMid = await h.repos.business.findOne({
      where: { tenantId: tenant.id },
    });
    expect(businessMid).not.toBeNull();
    const profileMid = await h.repos.profile.findOne({
      where: { tenantId: tenant.id, slug: 'default' },
    });
    expect(profileMid).toBeNull();

    // Restore the original save, retry.
    (h.repos.profile as any).save = originalSave;

    await h.communicationProvisioningService.provisionCommunicationChain(
      tenant,
    );
    // The invariant we care about is DB state — the recovery MUST leave
    // exactly one business + one profile, not two of either. The
    // `created` boolean returned by the service reports whether the
    // whole chain was modified on this run, not per-entity, so it's not
    // a reliable signal for what specifically was inserted.

    // Assert singletons.
    const businessCount = await h.repos.business.count({
      where: { tenantId: tenant.id },
    });
    expect(businessCount).toBe(1);
    const profileCount = await h.repos.profile.count({
      where: { tenantId: tenant.id, slug: 'default' },
    });
    expect(profileCount).toBe(1);

    // Audit clean.
    const report = await h.providerContextAuditService.run();
    expect(report.counts.duplicateIntegrations).toBe(0);
    expect(report.counts.tenantsWithoutChain).toBe(0);
  });
});
