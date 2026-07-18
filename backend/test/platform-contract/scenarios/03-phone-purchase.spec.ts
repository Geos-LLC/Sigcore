/**
 * Scenario 3 — Phone Purchase.
 *
 * Invariant: after `PhoneNumberProvisioningService.purchaseNumber`
 * completes, the freshly created `tenant_phone_numbers` row is:
 *
 *   - active
 *   - stamped with the correct `communication_integration_id` (the
 *     canonical WORKSPACE-scoped Twilio row seeded by the baseline)
 *   - linked into a PPA under the tenant's default profile
 *
 * And the readiness endpoint reports `ready` after purchase.
 *
 * Uses `MockTwilioProvider` so the purchase is hermetic — no
 * api.twilio.com calls, no billing.
 */

import { bootHarness, PlatformContractHarness } from '../support/harness';
import { PricingType } from '../../../src/database/entities/phone-number-pricing.entity';

describe('Platform Contract — Scenario 3: Phone Purchase', () => {
  let h: PlatformContractHarness;
  let baselineIntegrationId: string;

  beforeAll(async () => { h = await bootHarness(); });
  afterAll(async () => { await h.close(); });
  beforeEach(async () => {
    await h.reset();
    const seed = await h.seedBaseline();
    baselineIntegrationId = seed.integrationId;
  });

  it('purchases a number, stamps TPN.communication_integration_id, and preserves readiness=ready', async () => {
    // 1. Provision tenant + chain (no phone yet).
    const externalTenantId = `ext-purchase-${Date.now()}`;
    const { tenant } = await h.tenantsService.findOrCreateTenantByExternalId(
      h.workspaceId,
      { externalTenantId, displayName: 'Purchase Test' },
    );
    await h.communicationProvisioningService.provisionCommunicationChain(tenant);

    // 2. Purchase a number. MockTwilioProvider returns a synthetic PN SID.
    const purchase = await h.phoneNumberProvisioningService.purchaseNumber(
      h.workspaceId,
      tenant.id,
      '+12065551234',
      undefined,
      'Purchase Test Number',
      'sms',
    );
    expect(purchase.success).toBe(true);
    expect(purchase.allocation).toBeDefined();
    const tpnId = purchase.allocation!.id;

    // 3. Verify TPN row invariants.
    const tpn = await h.repos.tpn.findOne({ where: { id: tpnId } });
    expect(tpn).not.toBeNull();
    expect(tpn!.tenantId).toBe(tenant.id);
    expect(tpn!.workspaceId).toBe(h.workspaceId);
    // The critical invariant — stamp must match the baseline integration.
    expect(tpn!.communicationIntegrationId).toBe(baselineIntegrationId);

    // 4. PPA linking the TPN to the tenant's default profile.
    const profile = await h.repos.profile.findOne({
      where: { tenantId: tenant.id, slug: 'default' },
    });
    expect(profile).not.toBeNull();
    const ppa = await h.repos.ppa.findOne({
      where: { profileId: profile!.id, tenantPhoneNumberId: tpnId, active: true },
    });
    expect(ppa).not.toBeNull();

    // 5. Readiness reports ready.
    const readiness = await h.communicationProvisioningService.getReadiness(tenant);
    expect(readiness.reason).toBe('ready');
    expect(readiness.activeTpn.communicationIntegrationId).toBe(baselineIntegrationId);
  });
});
