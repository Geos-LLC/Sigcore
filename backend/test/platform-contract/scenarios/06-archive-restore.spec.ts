/**
 * Scenario 6 — Archive / Restore.
 *
 * Invariant: repeatedly archiving (`status='inactive'`) and restoring
 * (`status='active'`) a tenant does not create duplicate businesses,
 * profiles, integrations, or PPAs. Re-running
 * `provisionCommunicationChain` after each cycle heals any missing
 * links without duplicating any existing rows.
 *
 * This models the 2026-07-13 Spotless incident: five re-provisioned
 * tenants ended up with orphaned pre-restore state coexisting with new
 * post-restore state, causing outbound routing to 422. The invariant
 * this test locks in: the provisioning service must be idempotent
 * enough to survive repeated archive/restore cycles.
 */

import { bootHarness, PlatformContractHarness } from '../support/harness';
import { TenantStatus } from '../../../src/database/entities/tenant.entity';

describe('Platform Contract — Scenario 6: Archive / Restore', () => {
  let h: PlatformContractHarness;

  beforeAll(async () => { h = await bootHarness(); });
  afterAll(async () => { await h.close(); });
  beforeEach(async () => {
    await h.reset();
    await h.seedBaseline();
  });

  it('3 archive/restore cycles produce zero duplicates and readiness stays ready', async () => {
    const externalTenantId = `ext-archive-${Date.now()}`;

    // Initial provisioning.
    let { tenant } = await h.tenantsService.findOrCreateTenantByExternalId(
      h.workspaceId,
      { externalTenantId, displayName: 'Archive Restore Test' },
    );
    await h.communicationProvisioningService.provisionCommunicationChain(tenant);
    await h.phoneNumberProvisioningService.purchaseNumber(
      h.workspaceId,
      tenant.id,
      '+12065552222',
      undefined,
      undefined,
      'sms',
    );

    for (let cycle = 0; cycle < 3; cycle++) {
      // Archive — set status to inactive via public update surface.
      tenant.status = TenantStatus.INACTIVE;
      await h.tenantsService.saveTenant(tenant);

      // Restore — active again + re-run provisioning to heal any gaps.
      // `findOrCreateTenantByExternalId` with `allowInactive:true` returns
      // the same tenant row without minting a new one.
      const restored = await h.tenantsService.findOrCreateTenantByExternalId(
        h.workspaceId,
        { externalTenantId, displayName: 'Archive Restore Test', allowInactive: true },
      );
      expect(restored.tenant.id).toBe(tenant.id);
      tenant = restored.tenant;
      tenant.status = TenantStatus.ACTIVE;
      await h.tenantsService.saveTenant(tenant);
      await h.communicationProvisioningService.provisionCommunicationChain(tenant);
    }

    // Assert singletons.
    const tenantCount = await h.repos.tenant.count({
      where: { externalId: externalTenantId, workspaceId: h.workspaceId },
    });
    expect(tenantCount).toBe(1);
    const businessCount = await h.repos.business.count({
      where: { tenantId: tenant.id },
    });
    expect(businessCount).toBe(1);
    const profileCount = await h.repos.profile.count({
      where: { tenantId: tenant.id, slug: 'default' },
    });
    expect(profileCount).toBe(1);
    const tpnCount = await h.repos.tpn.count({
      where: { tenantId: tenant.id },
    });
    expect(tpnCount).toBe(1);

    // Audit clean; readiness ready.
    const report = await h.providerContextAuditService.run();
    expect(report.counts.duplicateIntegrations).toBe(0);
    expect(report.counts.unstampedTpns).toBe(0);
    expect(report.counts.legacyWorkspaceRows).toBe(0);
    expect(report.counts.tenantsWithoutChain).toBe(0);
    const readiness = await h.communicationProvisioningService.getReadiness(tenant);
    expect(readiness.reason).toBe('ready');
  });
});
