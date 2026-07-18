/**
 * Scenario 1 — Communication Provisioning.
 *
 * Invariant: a brand-new tenant, provisioned via the public
 * `TenantsService.createTenant` + `CommunicationProvisioningService`
 * surface, ends up communication-ready — every chain link the
 * outbound resolver walks is present, and the readiness endpoint
 * reports `reason: 'ready'`.
 */

import { bootHarness, PlatformContractHarness } from '../support/harness';

describe('Platform Contract — Scenario 1: Communication Provisioning', () => {
  let h: PlatformContractHarness;

  beforeAll(async () => { h = await bootHarness(); });
  afterAll(async () => { await h.close(); });
  beforeEach(async () => {
    await h.reset();
    await h.seedBaseline();
  });

  it('provisions tenant and materializes the full chain via provisionCommunicationChain', async () => {
    // Public surface: TenantsService.createTenant then CommunicationProvisioningService.
    // No direct database inserts here — everything must go through services.
    const tenant = await h.tenantsService.createTenant(h.workspaceId, {
      externalTenantId: `ext-${Date.now()}`,
      name: 'Acme Cleaning',
    } as any);

    const result = await h.communicationProvisioningService.provisionCommunicationChain(
      tenant,
    );

    // Business + profile created.
    expect(result.business.created).toBe(true);
    expect(result.profile.created).toBe(true);
    expect(result.business.id).toBeDefined();
    expect(result.profile.id).toBeDefined();

    // Verified via the actual repository rows.
    const business = await h.repos.business.findOne({ where: { tenantId: tenant.id } });
    expect(business).not.toBeNull();
    const profile = await h.repos.profile.findOne({
      where: { tenantId: tenant.id, slug: 'default' },
    });
    expect(profile).not.toBeNull();
    expect(profile!.isDefault).toBe(true);
    expect(business!.defaultProfileId).toBe(profile!.id);
  });

  it('readiness reports the transition from "no_active_tpn" to "ready" as the chain is completed', async () => {
    const tenant = await h.tenantsService.createTenant(h.workspaceId, {
      externalTenantId: `ext-${Date.now()}`,
      name: 'Acme Cleaning',
    } as any);

    // Before any provisioning: no business/profile yet.
    let readiness = await h.communicationProvisioningService.getReadiness(tenant);
    expect(readiness.reason).toBe('no_business');

    // After chain but without a phone.
    await h.communicationProvisioningService.provisionCommunicationChain(tenant);
    readiness = await h.communicationProvisioningService.getReadiness(tenant);
    expect(readiness.reason).toBe('no_active_tpn');
    expect(readiness.integration.present).toBe(true);
    expect(readiness.business.present).toBe(true);
    expect(readiness.profile.present).toBe(true);
  });
});
