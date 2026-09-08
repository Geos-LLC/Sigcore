/**
 * Tests for `IntegrationsService.getOpenPhoneStatus` — the read-only
 * connection-state endpoint added for TASKS_2026-09-08_CONVERSATION_SYNC.md
 * Task 5. Before this endpoint, callers had to infer connection state from
 * side-channels (a 404 on `/openphone/numbers`, or a "no integration"
 * exception on `/integrations/sync`). Now `GET /integrations/openphone`
 * returns a `{ connected, scope, ownedPhoneNumberCount, ... }` shape.
 *
 * Contract:
 *  - Tenant-scoped call with tenant integration → scope='tenant', connected=true
 *  - Tenant-scoped call with only workspace integration → scope='workspace', connected=true
 *  - No integration at all → scope='none', connected=false
 *  - `ownedPhoneNumberCount` reflects `tenant_phone_numbers` count for the
 *    tenant with `provider='openphone'` — the same input the Task 2
 *    ownership guard uses to decide sync skip/keep.
 */

import { IntegrationsService } from './integrations.service';
import {
  IntegrationStatus,
  ProviderType,
} from '../../database/entities/communication-integration.entity';
import { PhoneNumberProvider } from '../../database/entities/tenant-phone-number.entity';

function buildMockRepo() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((data: any) => ({ ...data })),
    save: jest.fn(async (entity: any) => entity),
    remove: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
    query: jest.fn().mockResolvedValue([]),
  };
}

function buildService() {
  const integrationRepo = buildMockRepo();
  const tenantIntegrationRepo = buildMockRepo();
  const tenantPhoneRepo = buildMockRepo();
  const tenantRepo = buildMockRepo();
  const workspaceRepo = buildMockRepo();
  const contactIdentityRepo = buildMockRepo();
  const snapshotRepo = buildMockRepo();
  const participantRepo = buildMockRepo();
  const openPhoneContactCache = {} as any;
  const encryptionService = {
    encrypt: jest.fn(),
    decrypt: jest.fn(),
  } as any;
  const openPhoneProvider = {} as any;
  const twilioProvider = {} as any;
  const twilioVoiceService = {} as any;
  const configService = { get: jest.fn() } as any;

  const service = new IntegrationsService(
    integrationRepo as any,
    tenantIntegrationRepo as any,
    tenantPhoneRepo as any,
    tenantRepo as any,
    workspaceRepo as any,
    contactIdentityRepo as any,
    snapshotRepo as any,
    participantRepo as any,
    openPhoneContactCache as any,
    encryptionService as any,
    openPhoneProvider as any,
    twilioProvider as any,
    twilioVoiceService as any,
    configService as any,
  );

  return {
    service,
    integrationRepo,
    tenantIntegrationRepo,
    tenantPhoneRepo,
  };
}

const WS_ID = 'ws-1';
const TENANT_A = 'tenant-a';

describe('IntegrationsService.getOpenPhoneStatus', () => {
  it('returns tenant-scoped connected=true when a TenantIntegration exists', async () => {
    const { service, tenantIntegrationRepo, tenantPhoneRepo } = buildService();
    const created = new Date('2026-06-01T00:00:00Z');
    tenantIntegrationRepo.findOne.mockResolvedValue({
      id: 'ti-1',
      workspaceId: WS_ID,
      tenantId: TENANT_A,
      provider: ProviderType.OPENPHONE,
      status: IntegrationStatus.ACTIVE,
      createdAt: created,
      metadata: { messageWebhookId: 'wh-msg', callWebhookId: 'wh-call' },
    });
    tenantPhoneRepo.count.mockResolvedValue(2);

    const result = await service.getOpenPhoneStatus(WS_ID, TENANT_A);

    expect(result).toEqual({
      connected: true,
      scope: 'tenant',
      integrationId: 'ti-1',
      status: IntegrationStatus.ACTIVE,
      connectedAt: created,
      ownedPhoneNumberCount: 2,
      metadata: { messageWebhookRegistered: true, callWebhookRegistered: true },
    });
    // Owned-phones count must be tenant-scoped, not workspace-wide.
    expect(tenantPhoneRepo.count).toHaveBeenCalledWith({
      where: {
        workspaceId: WS_ID,
        tenantId: TENANT_A,
        provider: PhoneNumberProvider.OPENPHONE,
      },
    });
  });

  it('falls back to workspace-scoped integration when no TenantIntegration exists', async () => {
    const { service, tenantIntegrationRepo, integrationRepo, tenantPhoneRepo } = buildService();
    tenantIntegrationRepo.findOne.mockResolvedValue(null);
    const created = new Date('2026-05-01T00:00:00Z');
    integrationRepo.findOne.mockResolvedValue({
      id: 'wi-1',
      provider: ProviderType.OPENPHONE,
      status: IntegrationStatus.ACTIVE,
      createdAt: created,
      metadata: {},
    });
    tenantPhoneRepo.count.mockResolvedValue(0);

    const result = await service.getOpenPhoneStatus(WS_ID, TENANT_A);

    expect(result.connected).toBe(true);
    expect(result.scope).toBe('workspace');
    expect(result.integrationId).toBe('wi-1');
    expect(result.ownedPhoneNumberCount).toBe(0);
    expect(result.metadata).toEqual({
      messageWebhookRegistered: false,
      callWebhookRegistered: false,
    });
  });

  it('returns scope="none" and connected=false when nothing is configured', async () => {
    const { service, tenantIntegrationRepo, integrationRepo, tenantPhoneRepo } = buildService();
    tenantIntegrationRepo.findOne.mockResolvedValue(null);
    integrationRepo.findOne.mockResolvedValue(null);
    tenantPhoneRepo.count.mockResolvedValue(0);

    const result = await service.getOpenPhoneStatus(WS_ID, TENANT_A);

    expect(result).toEqual({
      connected: false,
      scope: 'none',
      integrationId: null,
      status: null,
      connectedAt: null,
      ownedPhoneNumberCount: 0,
      metadata: { messageWebhookRegistered: false, callWebhookRegistered: false },
    });
  });

  it('reports connected=false when a TenantIntegration exists but is not ACTIVE', async () => {
    const { service, tenantIntegrationRepo, tenantPhoneRepo } = buildService();
    tenantIntegrationRepo.findOne.mockResolvedValue({
      id: 'ti-inactive',
      status: IntegrationStatus.INACTIVE,
      createdAt: new Date(),
      metadata: {},
    });
    tenantPhoneRepo.count.mockResolvedValue(1);

    const result = await service.getOpenPhoneStatus(WS_ID, TENANT_A);

    // Row exists so scope='tenant', but a non-ACTIVE status means "not usable".
    expect(result.scope).toBe('tenant');
    expect(result.connected).toBe(false);
    expect(result.status).toBe(IntegrationStatus.INACTIVE);
  });

  it('for workspace-scoped callers (tenantId=null), counts OpenPhone TPNs across the whole workspace', async () => {
    const { service, integrationRepo, tenantIntegrationRepo, tenantPhoneRepo } = buildService();
    tenantIntegrationRepo.findOne.mockResolvedValue(null);
    integrationRepo.findOne.mockResolvedValue({
      id: 'wi-1',
      status: IntegrationStatus.ACTIVE,
      createdAt: new Date(),
      metadata: {},
    });
    tenantPhoneRepo.count.mockResolvedValue(7);

    const result = await service.getOpenPhoneStatus(WS_ID, null);

    expect(result.scope).toBe('workspace');
    expect(result.ownedPhoneNumberCount).toBe(7);
    // Workspace call: no tenant_id predicate in the count.
    expect(tenantPhoneRepo.count).toHaveBeenCalledWith({
      where: { workspaceId: WS_ID, provider: PhoneNumberProvider.OPENPHONE },
    });
    // The tenant-scoped lookup should not have fired at all.
    expect(tenantIntegrationRepo.findOne).not.toHaveBeenCalled();
  });
});
