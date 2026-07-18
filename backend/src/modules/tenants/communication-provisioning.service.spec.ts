/**
 * Wave-3 completion 2026-07-18 — communication-ready provisioning spec.
 *
 * Locks in the invariant that `CommunicationProvisioningService` is:
 *
 *   1. Idempotent — safe to re-run on partial state.
 *   2. Additive — never rotates integration credentials.
 *   3. Correct on the readiness report — every missing chain step
 *      resolves to a specific `reason` slug so callers (LB, CI) can
 *      distinguish "no integration" from "no PPA" without parsing
 *      free-form strings.
 *
 * Uses hand-rolled repo mocks matching the pattern used in the resolver
 * + audit specs.
 */

import { IsNull } from 'typeorm';
import { CommunicationProvisioningService } from './communication-provisioning.service';
import {
  IntegrationStatus,
  ProviderType,
} from '../../database/entities/communication-integration.entity';
import { PhoneNumberAllocationStatus } from '../../database/entities/tenant-phone-number.entity';
import { WebhookSubscriptionStatus } from '../../database/entities/webhook-subscription.entity';

function makeRepo(defaultRows: any[] = []) {
  const store = new Map<string, any>();
  defaultRows.forEach((r, i) => store.set(r.id ?? `row-${i}`, r));
  return {
    _store: store,
    findOne: jest.fn(async ({ where }: any) => {
      for (const r of store.values()) {
        let match = true;
        for (const [k, v] of Object.entries(where)) {
          if ((v as any)?._type === 'isNull') {
            if (r[k] != null) { match = false; break; }
          } else if (r[k] !== v) { match = false; break; }
        }
        if (match) return r;
      }
      return null;
    }),
    find: jest.fn(async ({ where }: any = {}) => {
      const rows: any[] = [];
      for (const r of store.values()) {
        let match = true;
        for (const [k, v] of Object.entries(where ?? {})) {
          if ((v as any)?._type === 'isNull') {
            if (r[k] != null) { match = false; break; }
          } else if (r[k] !== v) { match = false; break; }
        }
        if (match) rows.push(r);
      }
      return rows;
    }),
    create: jest.fn((v: any) => ({ ...v })),
    save: jest.fn(async (v: any) => {
      const id = v.id ?? `gen-${store.size + 1}`;
      const withId = { ...v, id };
      store.set(id, withId);
      return withId;
    }),
  };
}

const TENANT = { id: 'tenant-1', workspaceId: 'ws-1', name: 'Acme', externalId: null } as any;

function build(opts: {
  integrations?: any[];
  tpns?: any[];
  businesses?: any[];
  profiles?: any[];
  ppas?: any[];
  webhooks?: any[];
} = {}) {
  const tenantRepo = makeRepo([TENANT]);
  const integrationRepo = makeRepo(opts.integrations ?? []);
  const tpnRepo = makeRepo(opts.tpns ?? []);
  const businessRepo = makeRepo(opts.businesses ?? []);
  const profileRepo = makeRepo(opts.profiles ?? []);
  const ppaRepo = makeRepo(opts.ppas ?? []);
  const webhookRepo = makeRepo(opts.webhooks ?? []);
  const apiKeyRepo = makeRepo([]);
  const svc = new CommunicationProvisioningService(
    tenantRepo as any,
    integrationRepo as any,
    tpnRepo as any,
    businessRepo as any,
    profileRepo as any,
    ppaRepo as any,
    webhookRepo as any,
    apiKeyRepo as any,
  );
  return {
    svc,
    tenantRepo,
    integrationRepo,
    tpnRepo,
    businessRepo,
    profileRepo,
    ppaRepo,
    webhookRepo,
  };
}

describe('CommunicationProvisioningService.getReadiness', () => {
  it('reports "no_integration" when no active integration exists', async () => {
    const { svc } = build();
    const report = await svc.getReadiness(TENANT);
    expect(report.reason).toBe('no_integration');
    expect(report.integration.present).toBe(false);
  });

  it('reports "no_business" when integration exists but chain missing', async () => {
    const { svc } = build({
      integrations: [{
        id: 'int-1', workspaceId: 'ws-1', provider: ProviderType.TWILIO,
        scopeType: 'WORKSPACE', ownerTenantId: null,
        status: IntegrationStatus.ACTIVE,
      }],
    });
    const report = await svc.getReadiness(TENANT);
    expect(report.reason).toBe('no_business');
    expect(report.integration.present).toBe(true);
  });

  it('reports "no_ppa_for_active_tpn" when profile exists + TPN exists but PPA missing', async () => {
    const { svc } = build({
      integrations: [{
        id: 'int-1', workspaceId: 'ws-1', provider: ProviderType.TWILIO,
        scopeType: 'WORKSPACE', ownerTenantId: null, status: IntegrationStatus.ACTIVE,
      }],
      businesses: [{ id: 'biz-1', tenantId: 'tenant-1' }],
      profiles: [{ id: 'prof-1', tenantId: 'tenant-1', slug: 'default' }],
      tpns: [{
        id: 'tpn-1', workspaceId: 'ws-1', tenantId: 'tenant-1',
        phoneNumber: '+1234567890', status: PhoneNumberAllocationStatus.ACTIVE,
      }],
    });
    const report = await svc.getReadiness(TENANT);
    expect(report.reason).toBe('no_ppa_for_active_tpn');
  });

  it('reports "ready" when every link is present', async () => {
    const { svc } = build({
      integrations: [{
        id: 'int-1', workspaceId: 'ws-1', provider: ProviderType.TWILIO,
        scopeType: 'WORKSPACE', ownerTenantId: null, status: IntegrationStatus.ACTIVE,
      }],
      businesses: [{ id: 'biz-1', tenantId: 'tenant-1' }],
      profiles: [{ id: 'prof-1', tenantId: 'tenant-1', slug: 'default' }],
      tpns: [{
        id: 'tpn-1', workspaceId: 'ws-1', tenantId: 'tenant-1',
        phoneNumber: '+1234567890', status: PhoneNumberAllocationStatus.ACTIVE,
        communicationIntegrationId: 'int-1',
      }],
      ppas: [{
        id: 'ppa-1', profileId: 'prof-1', tenantPhoneNumberId: 'tpn-1', active: true,
      }],
    });
    const report = await svc.getReadiness(TENANT);
    expect(report.reason).toBe('ready');
    expect(report.integration.present).toBe(true);
    expect(report.business.present).toBe(true);
    expect(report.profile.present).toBe(true);
    expect(report.activeTpn.present).toBe(true);
    expect(report.ppa.present).toBe(true);
  });
});

describe('CommunicationProvisioningService.provisionCommunicationChain', () => {
  it('creates business + default profile when nothing exists (no TPN)', async () => {
    const { svc, businessRepo, profileRepo } = build();
    const result = await svc.provisionCommunicationChain(TENANT);
    expect(result.business.created).toBe(true);
    expect(result.profile.created).toBe(true);
    expect(result.ppa.id).toBeNull();
    expect(businessRepo.save).toHaveBeenCalled();
    expect(profileRepo.save).toHaveBeenCalled();
  });

  it('is idempotent — re-running against a ready tenant makes no writes', async () => {
    // `makeSlug('Acme', 'tenant-1')` = 'acme-tenant-1' — use the same
    // computed slug so the existence check in ensureBusinessAndProfileWithoutTpn
    // finds the seed row and skips create.
    const { svc, businessRepo, profileRepo, ppaRepo } = build({
      businesses: [{ id: 'biz-1', tenantId: 'tenant-1', slug: 'acme-tenant-1', defaultProfileId: 'prof-1' }],
      profiles: [{ id: 'prof-1', tenantId: 'tenant-1', communicationBusinessId: 'biz-1', slug: 'default' }],
    });
    const result = await svc.provisionCommunicationChain(TENANT);
    expect(result.business.created).toBe(false);
    expect(result.profile.created).toBe(false);
    // The save on business only happens if defaultProfileId drifted. Not
    // called here since it's already pinned.
    expect(businessRepo.save).not.toHaveBeenCalled();
    expect(profileRepo.save).not.toHaveBeenCalled();
    expect(ppaRepo.save).not.toHaveBeenCalled();
  });

  it('does NOT create an integration (assertion-only)', async () => {
    const { svc, integrationRepo } = build();
    await svc.provisionCommunicationChain(TENANT);
    expect(integrationRepo.save).not.toHaveBeenCalled();
    expect(integrationRepo.create).not.toHaveBeenCalled();
  });

  it('stamps TPN.communication_integration_id when supplied a phone and an active integration', async () => {
    const { svc, tpnRepo } = build({
      integrations: [{
        id: 'int-1', workspaceId: 'ws-1', provider: ProviderType.TWILIO,
        scopeType: 'WORKSPACE', ownerTenantId: null, status: IntegrationStatus.ACTIVE,
      }],
      tpns: [{
        id: 'tpn-1', workspaceId: 'ws-1', tenantId: 'tenant-1',
        phoneNumber: '+1234567890', status: PhoneNumberAllocationStatus.ACTIVE,
        communicationIntegrationId: null,
      }],
    });
    await svc.provisionCommunicationChain(TENANT, { phoneNumber: '+1234567890' });
    const stampedTpn = tpnRepo._store.get('tpn-1');
    expect(stampedTpn.communicationIntegrationId).toBe('int-1');
  });

  it('ensures webhook subscription when webhook.url supplied', async () => {
    const { svc, webhookRepo } = build();
    const result = await svc.provisionCommunicationChain(TENANT, {
      webhook: { url: 'https://example.com/hook' },
    });
    expect(result.webhookSubscription.created).toBe(true);
    expect(webhookRepo.save).toHaveBeenCalled();
  });

  it('reuses existing webhook subscription — no duplicate insert', async () => {
    const { svc, webhookRepo } = build({
      webhooks: [{
        id: 'wh-1', workspaceId: 'ws-1', tenantId: 'tenant-1',
        webhookUrl: 'https://example.com/hook',
        status: WebhookSubscriptionStatus.ACTIVE,
      }],
    });
    const result = await svc.provisionCommunicationChain(TENANT, {
      webhook: { url: 'https://example.com/hook' },
    });
    expect(result.webhookSubscription.created).toBe(false);
    expect(result.webhookSubscription.id).toBe('wh-1');
    expect(webhookRepo.save).not.toHaveBeenCalled();
  });

  it('rejects non-http(s) webhook URLs', async () => {
    const { svc } = build();
    await expect(
      svc.provisionCommunicationChain(TENANT, { webhook: { url: 'javascript:alert(1)' } }),
    ).rejects.toThrow('webhook.url must be http(s)://');
  });
});
