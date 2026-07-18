/**
 * Scenario 4 — Provider Context.
 *
 * Invariants:
 *
 *   a) `ProviderContextResolver.resolve()` picks a deterministic
 *      integration for the resolved TPN — always rule 1 (`by_number`)
 *      when the TPN is stamped, regardless of how many other
 *      integrations the workspace holds.
 *
 *   b) The partial unique indexes prevent duplicate active integrations
 *      from ever being written — attempting to create a second
 *      WORKSPACE-scoped row for the same (workspace, provider) raises
 *      23505, and the caller resolves to the winning row.
 */

import { ConflictException } from '@nestjs/common';
import { bootHarness, PlatformContractHarness } from '../support/harness';
import {
  IntegrationStatus,
  ProviderType,
} from '../../../src/database/entities/communication-integration.entity';

describe('Platform Contract — Scenario 4: Provider Context', () => {
  let h: PlatformContractHarness;
  let baselineIntegrationId: string;

  beforeAll(async () => { h = await bootHarness(); });
  afterAll(async () => { await h.close(); });
  beforeEach(async () => {
    await h.reset();
    const seed = await h.seedBaseline();
    baselineIntegrationId = seed.integrationId;
  });

  it('resolver returns the same integration for the same TPN across repeated calls', async () => {
    const externalTenantId = `ext-resolver-${Date.now()}`;
    const { tenant } = await h.tenantsService.findOrCreateTenantByExternalId(
      h.workspaceId,
      { externalTenantId, displayName: 'Resolver Deterministic' },
    );
    await h.communicationProvisioningService.provisionCommunicationChain(tenant);
    const purchase = await h.phoneNumberProvisioningService.purchaseNumber(
      h.workspaceId,
      tenant.id,
      '+12065559999',
      undefined,
      undefined,
      'sms',
    );
    const tpnId = purchase.allocation!.id;
    const phone = purchase.allocation!.phoneNumber;

    // Call resolve 5 times — expect the same integration id every time,
    // and rule `by_number` every time (rule 1 is the canonical path).
    const seen = new Set<string>();
    const rules = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const ctx = await h.providerContextResolver.resolve({
        workspaceId: h.workspaceId,
        provider: ProviderType.TWILIO,
        fromNumber: phone,
        tenantId: tenant.id,
      });
      seen.add(ctx.integration.id);
      rules.add(ctx.rule);
    }
    expect(seen.size).toBe(1);
    expect([...seen][0]).toBe(baselineIntegrationId);
    expect(rules.size).toBe(1);
    expect([...rules][0]).toBe('by_number');
    // Sanity — TPN id from resolver's TPN lookup can be cross-checked.
    void tpnId;
  });

  it('partial unique index blocks a second WORKSPACE-scoped row for the same (workspace, provider)', async () => {
    // Attempt to insert a duplicate workspace-scoped row directly via
    // the repository. The partial unique index
    // UQ_communication_integrations_ws_provider_workspace_scoped must
    // raise 23505.
    await expect(
      h.repos.integration.save(
        h.repos.integration.create({
          workspaceId: h.workspaceId,
          provider: ProviderType.TWILIO,
          credentialsEncrypted: h.encryptionService.encrypt('{"accountSid":"AC2","authToken":"tok2"}'),
          externalWorkspaceId: 'AC2',
          status: IntegrationStatus.ACTIVE,
          scopeType: 'WORKSPACE',
          ownerTenantId: null,
        } as any),
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('resolver produces a structured 409 body when a workspace holds a rule-4-ambiguous pair', async () => {
    // Create a second, TENANT-scoped row for a distinct tenant. This
    // coexists legally with the WORKSPACE row per the partial uniques.
    const externalTenantId = `ext-tenant-scoped-${Date.now()}`;
    const { tenant } = await h.tenantsService.findOrCreateTenantByExternalId(
      h.workspaceId,
      { externalTenantId, displayName: 'Tenant-scoped Owner' },
    );
    await h.repos.integration.save(
      h.repos.integration.create({
        workspaceId: h.workspaceId,
        provider: ProviderType.TWILIO,
        credentialsEncrypted: h.encryptionService.encrypt('{"accountSid":"AC3","authToken":"tok3"}'),
        externalWorkspaceId: 'AC3',
        status: IntegrationStatus.ACTIVE,
        scopeType: 'TENANT',
        ownerTenantId: tenant.id,
      } as any),
    );

    // Ask the resolver with NO stronger hint — should hit rule 4 with
    // 2 candidates and throw the structured 409.
    try {
      await h.providerContextResolver.resolve({
        workspaceId: h.workspaceId,
        provider: ProviderType.TWILIO,
      });
      throw new Error('expected ConflictException');
    } catch (err: any) {
      expect(err).toBeInstanceOf(ConflictException);
      const body = err.getResponse();
      expect(body.error).toBe('ProviderContextAmbiguous');
      expect(body.resolutionStage).toBe('by_legacy_workspace_fallback');
      expect(body.candidateIntegrationIds).toHaveLength(2);
      expect(body.candidateScopeTypes).toEqual(
        expect.arrayContaining(['WORKSPACE', 'TENANT']),
      );
    }
  });
});
