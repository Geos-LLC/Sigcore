/**
 * Scenario 5 — Audit.
 *
 * Invariant: after any legal sequence of public-surface operations
 * (provision, purchase, archive, restore, re-provision) the audit
 * endpoint reports zero across all four sections. This is the
 * regression barrier the CI job keys off.
 */

import { bootHarness, PlatformContractHarness } from '../support/harness';

describe('Platform Contract — Scenario 5: Audit invariant', () => {
  let h: PlatformContractHarness;

  beforeAll(async () => { h = await bootHarness(); });
  afterAll(async () => { await h.close(); });
  beforeEach(async () => {
    await h.reset();
    await h.seedBaseline();
  });

  async function assertAuditClean() {
    const report = await h.providerContextAuditService.run();
    expect(report.counts.duplicateIntegrations).toBe(0);
    expect(report.counts.unstampedTpns).toBe(0);
    expect(report.counts.legacyWorkspaceRows).toBe(0);
    expect(report.counts.tenantsWithoutChain).toBe(0);
  }

  it('is clean immediately after seedBaseline', async () => {
    await assertAuditClean();
  });

  it('is clean after provisioning + purchasing a number', async () => {
    const { tenant } = await h.tenantsService.findOrCreateTenantByExternalId(
      h.workspaceId,
      { externalTenantId: `ext-audit-${Date.now()}`, displayName: 'Audit Test' },
    );
    await h.communicationProvisioningService.provisionCommunicationChain(tenant);
    await h.phoneNumberProvisioningService.purchaseNumber(
      h.workspaceId,
      tenant.id,
      '+12065550001',
      undefined,
      undefined,
      'sms',
    );

    await assertAuditClean();
  });

  it('is clean after 3 tenants each with their own purchased number', async () => {
    for (let i = 0; i < 3; i++) {
      const { tenant } = await h.tenantsService.findOrCreateTenantByExternalId(
        h.workspaceId,
        {
          externalTenantId: `ext-audit-fleet-${i}-${Date.now()}`,
          displayName: `Fleet ${i}`,
        },
      );
      await h.communicationProvisioningService.provisionCommunicationChain(tenant);
      await h.phoneNumberProvisioningService.purchaseNumber(
        h.workspaceId,
        tenant.id,
        `+12065551${(100 + i).toString().padStart(3, '0')}`,
        undefined,
        undefined,
        'sms',
      );
    }

    await assertAuditClean();
  });
});
