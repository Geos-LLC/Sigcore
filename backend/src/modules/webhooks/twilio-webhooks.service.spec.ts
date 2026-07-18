import { TwilioWebhooksService } from './twilio-webhooks.service';
import { ProviderType } from '../../database/entities/communication-integration.entity';

// Incident 2026-07-14 Phase 4a — spec coverage for the defensive
// AccountSid-aware lookup on `getAuthToken`.

function repo() {
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn((x: any) => x),
    delete: jest.fn(),
    createQueryBuilder: jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn(),
      getMany: jest.fn(),
    })),
  };
}

function buildSvc() {
  const conversationRepo = repo();
  const messageRepo = repo();
  const callRepo = repo();
  const integrationRepo = repo();
  const workspaceRepo = repo();
  const tenantPhoneNumberRepo = repo();
  const tenantRepo = repo();
  const ccSettingsRepo = repo();

  const encryptionService = {
    decrypt: jest.fn(() => JSON.stringify({ authToken: 'tok_from_encrypted' })),
  } as any;
  const eventsGateway = {} as any;
  const configService = { get: jest.fn() } as any;
  const idempotencyService = {} as any;

  const svc = new TwilioWebhooksService(
    conversationRepo as any,
    messageRepo as any,
    callRepo as any,
    integrationRepo as any,
    workspaceRepo as any,
    tenantPhoneNumberRepo as any,
    tenantRepo as any,
    ccSettingsRepo as any,
    encryptionService,
    eventsGateway,
    configService,
    idempotencyService,
  );
  return { svc, integrationRepo, encryptionService };
}

describe('TwilioWebhooksService.getAuthToken — Phase 4a defensive lookup', () => {
  it('getAuthToken_prefers_accountSid_when_provided — where clause includes externalWorkspaceId', async () => {
    const { svc, integrationRepo } = buildSvc();
    integrationRepo.findOne.mockResolvedValue({
      id: 'int-1',
      credentialsEncrypted: 'enc',
    });

    const token = await svc.getAuthToken('ws-1', 'AC_pilot_subaccount');

    expect(integrationRepo.findOne).toHaveBeenCalledTimes(1);
    const call = integrationRepo.findOne.mock.calls[0][0];
    expect(call.where).toEqual({
      workspaceId: 'ws-1',
      provider: ProviderType.TWILIO,
      externalWorkspaceId: 'AC_pilot_subaccount',
    });
    expect(token).toBe('tok_from_encrypted');
  });

  it('getAuthToken_falls_back_to_workspace_scoped_only_when_accountSid_absent — where clause omits externalWorkspaceId and constrains to ownerTenantId IS NULL', async () => {
    // Wave-3 completion 2026-07-18: the AccountSid-less fallback now
    // constrains to WORKSPACE-scoped rows (ownerTenantId IS NULL) so the
    // signature check can never accidentally decrypt a tenant-scoped
    // row's authToken. See TwilioWebhooksService.getAuthToken comment.
    const { svc, integrationRepo } = buildSvc();
    integrationRepo.findOne.mockResolvedValue({
      id: 'int-legacy',
      credentialsEncrypted: 'enc',
    });

    const token = await svc.getAuthToken('ws-1');

    expect(integrationRepo.findOne).toHaveBeenCalledTimes(1);
    const call = integrationRepo.findOne.mock.calls[0][0];
    expect(call.where.workspaceId).toBe('ws-1');
    expect(call.where.provider).toBe(ProviderType.TWILIO);
    expect(call.where.externalWorkspaceId).toBeUndefined();
    // The ownerTenantId constraint is a typeorm FindOperator (IsNull()).
    // Match its shape rather than the exact instance.
    expect(call.where.ownerTenantId).toBeDefined();
    expect(call.where.ownerTenantId?._type).toBe('isNull');
    expect(token).toBe('tok_from_encrypted');
  });

  it('returns null when no integration row exists (both branches)', async () => {
    const { svc, integrationRepo } = buildSvc();
    integrationRepo.findOne.mockResolvedValue(null);

    expect(await svc.getAuthToken('ws-1', 'AC_x')).toBeNull();
    expect(await svc.getAuthToken('ws-1')).toBeNull();
  });

  it('returns null when integration row has no credentialsEncrypted', async () => {
    const { svc, integrationRepo } = buildSvc();
    integrationRepo.findOne.mockResolvedValue({ id: 'int-1', credentialsEncrypted: null });

    expect(await svc.getAuthToken('ws-1', 'AC_x')).toBeNull();
  });
});
