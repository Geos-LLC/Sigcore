/**
 * Regression tests — readiness-report Fix C, 2026-05-08.
 *
 * Before this fix, `IntegrationsService.disconnectOpenPhoneForTenant` removed
 * the `tenant_integrations` row but did NOT call
 * `openPhoneProvider.deleteWebhooks()` for any webhook IDs the integration
 * carried in `metadata`. The workspace-scoped `deleteIntegration` already
 * does this. Tenant-scoped disconnects asymmetrically left orphaned
 * OpenPhone-side webhooks behind, accumulating across reconnect cycles.
 *
 * The current `connectOpenPhoneForTenant` does not register tenant-scoped
 * webhooks (workspace webhook URL is reused; tenant routing is resolved
 * server-side from the inbound payload). So in production today there are
 * no metadata webhook IDs to clean up. The fix is structural:
 *   - Symmetry with the workspace-scoped delete.
 *   - Forward-compatibility with any future flow that DOES register
 *     per-tenant webhooks (e.g. tenant-specific webhook URLs).
 *   - Idempotent disconnect for any TenantIntegration that came in via a
 *     migration tool with metadata pre-populated.
 *
 * Tests cover:
 *   - happy path: no integration row → idempotent success
 *   - no metadata: row is removed, deleteWebhooks NOT called
 *   - metadata without webhook IDs: row is removed, deleteWebhooks NOT called
 *   - metadata with messageWebhookId only: deleteWebhooks called, row removed
 *   - metadata with both ids: deleteWebhooks called with both, row removed
 *   - deleteWebhooks throws: WARNING logged, row STILL removed (best-effort)
 */

import { IntegrationsService } from './integrations.service';
import { ProviderType } from '../../database/entities/communication-integration.entity';

function buildMockRepo() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((data: any) => ({ ...data })),
    save: jest.fn(async (entity: any) => entity),
    remove: jest.fn(),
    update: jest.fn(),
  };
}

function buildService() {
  const integrationRepo = buildMockRepo();
  const tenantIntegrationRepo = buildMockRepo();
  const workspaceRepo = buildMockRepo();
  const contactIdentityRepo = buildMockRepo();
  const snapshotRepo = buildMockRepo();
  const participantRepo = buildMockRepo();
  const openPhoneContactCache = {} as any;
  const encryptionService = {
    encrypt: jest.fn().mockReturnValue('encrypted-creds'),
    decrypt: jest.fn().mockReturnValue('decrypted-creds'),
  };
  const openPhoneProvider = {
    deleteWebhooks: jest.fn().mockResolvedValue(undefined),
    validateCredentials: jest.fn().mockResolvedValue(true),
    getPhoneNumbersFromCredentials: jest.fn().mockResolvedValue(new Map()),
    registerWebhooks: jest.fn(),
  } as any;
  const twilioProvider = {} as any;
  const twilioVoiceService = {} as any;
  const configService = { get: jest.fn() } as any;

  const service = new IntegrationsService(
    integrationRepo as any,
    tenantIntegrationRepo as any,
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
    tenantIntegrationRepo,
    encryptionService,
    openPhoneProvider,
  };
}

const WS_ID = 'ws-1';
const TENANT_A = 'tenant-a';

describe('IntegrationsService — disconnectOpenPhoneForTenant (Fix C)', () => {
  it('returns success and skips cleanup when no integration row exists', async () => {
    const { service, tenantIntegrationRepo, openPhoneProvider } = buildService();
    tenantIntegrationRepo.findOne.mockResolvedValue(null);

    const result = await service.disconnectOpenPhoneForTenant(WS_ID, TENANT_A);

    expect(result).toEqual({ success: true });
    expect(openPhoneProvider.deleteWebhooks).not.toHaveBeenCalled();
    expect(tenantIntegrationRepo.remove).not.toHaveBeenCalled();
  });

  it('removes the row but does NOT call deleteWebhooks when metadata is null', async () => {
    const { service, tenantIntegrationRepo, openPhoneProvider } = buildService();
    const integration = {
      id: 'ti-1',
      workspaceId: WS_ID,
      tenantId: TENANT_A,
      provider: ProviderType.OPENPHONE,
      credentialsEncrypted: 'enc',
      metadata: null,
    };
    tenantIntegrationRepo.findOne.mockResolvedValue(integration);

    const result = await service.disconnectOpenPhoneForTenant(WS_ID, TENANT_A);

    expect(result).toEqual({ success: true });
    expect(openPhoneProvider.deleteWebhooks).not.toHaveBeenCalled();
    expect(tenantIntegrationRepo.remove).toHaveBeenCalledWith(integration);
  });

  it('removes the row but does NOT call deleteWebhooks when metadata has no webhook IDs', async () => {
    const { service, tenantIntegrationRepo, openPhoneProvider } = buildService();
    const integration = {
      id: 'ti-2',
      workspaceId: WS_ID,
      tenantId: TENANT_A,
      provider: ProviderType.OPENPHONE,
      credentialsEncrypted: 'enc',
      metadata: { someOtherField: 'value' },
    };
    tenantIntegrationRepo.findOne.mockResolvedValue(integration);

    const result = await service.disconnectOpenPhoneForTenant(WS_ID, TENANT_A);

    expect(result).toEqual({ success: true });
    expect(openPhoneProvider.deleteWebhooks).not.toHaveBeenCalled();
    expect(tenantIntegrationRepo.remove).toHaveBeenCalledWith(integration);
  });

  it('calls deleteWebhooks with messageWebhookId only when callWebhookId absent', async () => {
    const { service, tenantIntegrationRepo, openPhoneProvider, encryptionService } = buildService();
    const integration = {
      id: 'ti-3',
      workspaceId: WS_ID,
      tenantId: TENANT_A,
      provider: ProviderType.OPENPHONE,
      credentialsEncrypted: 'enc-msg-only',
      metadata: { messageWebhookId: 'wh-msg-1' },
    };
    tenantIntegrationRepo.findOne.mockResolvedValue(integration);

    await service.disconnectOpenPhoneForTenant(WS_ID, TENANT_A);

    expect(encryptionService.decrypt).toHaveBeenCalledWith('enc-msg-only');
    expect(openPhoneProvider.deleteWebhooks).toHaveBeenCalledWith('decrypted-creds', {
      messageWebhookId: 'wh-msg-1',
      callWebhookId: undefined,
    });
    expect(tenantIntegrationRepo.remove).toHaveBeenCalledWith(integration);
  });

  it('calls deleteWebhooks with both ids when both present, then removes row', async () => {
    const { service, tenantIntegrationRepo, openPhoneProvider } = buildService();
    const integration = {
      id: 'ti-4',
      workspaceId: WS_ID,
      tenantId: TENANT_A,
      provider: ProviderType.OPENPHONE,
      credentialsEncrypted: 'enc-both',
      metadata: { messageWebhookId: 'wh-msg-2', callWebhookId: 'wh-call-2' },
    };
    tenantIntegrationRepo.findOne.mockResolvedValue(integration);

    await service.disconnectOpenPhoneForTenant(WS_ID, TENANT_A);

    expect(openPhoneProvider.deleteWebhooks).toHaveBeenCalledWith('decrypted-creds', {
      messageWebhookId: 'wh-msg-2',
      callWebhookId: 'wh-call-2',
    });
    expect(tenantIntegrationRepo.remove).toHaveBeenCalledWith(integration);
  });

  it('still removes the row when deleteWebhooks throws (best-effort cleanup)', async () => {
    const { service, tenantIntegrationRepo, openPhoneProvider } = buildService();
    const integration = {
      id: 'ti-5',
      workspaceId: WS_ID,
      tenantId: TENANT_A,
      provider: ProviderType.OPENPHONE,
      credentialsEncrypted: 'enc-fail',
      metadata: { messageWebhookId: 'wh-msg-fail', callWebhookId: 'wh-call-fail' },
    };
    tenantIntegrationRepo.findOne.mockResolvedValue(integration);
    openPhoneProvider.deleteWebhooks.mockRejectedValueOnce(new Error('OpenPhone API 503'));

    const result = await service.disconnectOpenPhoneForTenant(WS_ID, TENANT_A);

    expect(result).toEqual({ success: true });
    expect(openPhoneProvider.deleteWebhooks).toHaveBeenCalledTimes(1);
    // The row MUST still be removed — otherwise an OpenPhone-side outage
    // would leave the tenant unable to disconnect at all.
    expect(tenantIntegrationRepo.remove).toHaveBeenCalledWith(integration);
  });
});
