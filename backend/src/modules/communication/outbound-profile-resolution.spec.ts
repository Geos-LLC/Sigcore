import { CommunicationService } from './communication.service';
import { RoutingError, RoutingErrorCode } from '../routing/routing-errors';
import { ProviderType, IntegrationStatus } from '../../database/entities/communication-integration.entity';
import { PhoneNumberProvider } from '../../database/entities/tenant-phone-number.entity';

/**
 * PR4 — sendMessageToPhoneNumber profile-resolution tests.
 *
 * Exercises the new `profileHint` argument and the resolver wiring:
 *   - profileId path → profile chosen by id, conversation tagged
 *   - profileSlug path → profile chosen by (tenantId, slug)
 *   - shared phone without profileId → AMBIGUOUS_FROM_NUMBER propagated
 *   - cross-tenant profileId → CROSS_TENANT_PROFILE
 *   - unique fromNumber-only → resolver picks the only profile (back-compat)
 *   - HF-style empty profile → PROFILE_NOT_CONFIGURED
 */

const WS = 'ws-test';
const TENANT = 'tenant-test';
const PROFILE_ID = 'profile-test';
const BUSINESS_ID = 'biz-test';

function buildMockRepo(): any {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((d: any) => ({ ...d })),
    save: jest.fn(async (e: any) => ({ id: e.id ?? 'gen-id', ...e })),
    update: jest.fn(),
    remove: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
    createQueryBuilder: jest.fn(),
  };
}

function makeService(opts: {
  resolveOutboundOverride?: { resolve: jest.Mock };
} = {}) {
  const integrationRepo = buildMockRepo();
  const tenantIntegrationRepo = buildMockRepo();
  const conversationRepo = buildMockRepo();
  const messageRepo = buildMockRepo();
  const callRepo = buildMockRepo();
  const senderRepo = buildMockRepo();
  const tenantPhoneNumberRepo = buildMockRepo();

  const openPhoneProvider = { sendMessage: jest.fn() };
  const twilioProvider = { sendMessage: jest.fn() };
  const whatsappWebProvider = { sendMessage: jest.fn() };
  const encryptionService = { decrypt: jest.fn().mockReturnValue('decrypted-creds'), encrypt: jest.fn() };
  const openPhoneContactCache = {
    upsertParticipantFromConversation: jest.fn(),
    sniffProviderAccountId: jest.fn().mockResolvedValue(''),
  };
  const resolveOutbound = opts.resolveOutboundOverride ?? {
    resolve: jest.fn(),
  };

  const service = new CommunicationService(
    integrationRepo,
    tenantIntegrationRepo,
    conversationRepo,
    messageRepo,
    callRepo,
    senderRepo,
    tenantPhoneNumberRepo,
    openPhoneProvider as any,
    twilioProvider as any,
    whatsappWebProvider as any,
    encryptionService as any,
    openPhoneContactCache as any,
    resolveOutbound as any,
  );

  return {
    service,
    integrationRepo,
    tenantIntegrationRepo,
    conversationRepo,
    messageRepo,
    tenantPhoneNumberRepo,
    twilioProvider,
    openPhoneProvider,
    resolveOutbound,
  };
}

/**
 * Stubs the lookups that the existing send path performs after resolver
 * succeeds. The test just needs `provider.sendMessage` to fire and the
 * conversation to be saved.
 */
function stubTwilioPath(harness: ReturnType<typeof makeService>, fromNumber: string) {
  // tenant_phone_numbers lookup (status='active' filter)
  harness.tenantPhoneNumberRepo.findOne.mockResolvedValue({
    id: 'tpn-1',
    workspaceId: WS,
    tenantId: TENANT,
    phoneNumber: fromNumber,
    provider: PhoneNumberProvider.TWILIO,
    status: 'active',
  });
  // tenant_integrations lookup (none)
  harness.tenantIntegrationRepo.findOne.mockResolvedValue(null);
  // workspace integration
  harness.integrationRepo.findOne.mockResolvedValue({
    id: 'int-twilio',
    workspaceId: WS,
    provider: ProviderType.TWILIO,
    status: IntegrationStatus.ACTIVE,
    credentialsEncrypted: 'enc',
  });
  // No existing conversation
  harness.conversationRepo.findOne.mockResolvedValue(null);
  harness.twilioProvider.sendMessage.mockResolvedValue({
    providerMessageId: 'sid-1',
    status: 'sent',
  });
}

describe('CommunicationService.sendMessageToPhoneNumber — profileHint paths', () => {
  it('happy path: profileId resolves and tags the conversation', async () => {
    const harness = makeService();
    harness.resolveOutbound.resolve.mockResolvedValue({
      profileId: PROFILE_ID,
      businessId: BUSINESS_ID,
      fromNumber: '+15551112222',
      source: 'profile_explicit',
    });
    stubTwilioPath(harness, '+15551112222');

    await harness.service.sendMessageToPhoneNumber(
      WS,
      '', // caller passed no fromNumber — resolver fills it in
      '+19998887777',
      'hi',
      'sms',
      TENANT,
      undefined,
      undefined,
      { profileId: PROFILE_ID },
    );

    expect(harness.resolveOutbound.resolve).toHaveBeenCalledWith({
      tenantId: TENANT,
      profileId: PROFILE_ID,
      profileSlug: undefined,
      fromNumber: undefined,
    });
    // Conversation save should have been called twice — once for create, once for tag.
    const savedConversations = harness.conversationRepo.save.mock.calls.map((c: any[]) => c[0]);
    const tagged = savedConversations.find(
      (c: any) => c.communicationProfileId === PROFILE_ID && c.communicationBusinessId === BUSINESS_ID,
    );
    expect(tagged).toBeDefined();
    expect(tagged.profileConfidence).toBe('operator_set');
    expect(harness.twilioProvider.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ from: '+15551112222', to: '+19998887777' }),
    );
  });

  it('happy path: profileSlug resolves to (tenantId, slug)', async () => {
    const harness = makeService();
    harness.resolveOutbound.resolve.mockResolvedValue({
      profileId: PROFILE_ID,
      businessId: BUSINESS_ID,
      fromNumber: '+15551112222',
      source: 'profile_slug',
    });
    stubTwilioPath(harness, '+15551112222');

    await harness.service.sendMessageToPhoneNumber(
      WS, '', '+19998887777', 'hello', 'sms', TENANT, undefined, undefined,
      { profileSlug: 'reminders' },
    );

    expect(harness.resolveOutbound.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ profileSlug: 'reminders', tenantId: TENANT }),
    );
  });

  it('back-compat: fromNumber-only with unique active assignment still sends', async () => {
    const harness = makeService();
    // Resolver picks the unique profile from fromNumber alone
    harness.resolveOutbound.resolve.mockResolvedValue({
      profileId: PROFILE_ID,
      businessId: BUSINESS_ID,
      fromNumber: '+15551112222',
      source: 'phone_unique',
    });
    stubTwilioPath(harness, '+15551112222');

    await harness.service.sendMessageToPhoneNumber(
      WS, '+15551112222', '+19998887777', 'hi', 'sms', TENANT, undefined, undefined, {},
    );

    expect(harness.resolveOutbound.resolve).toHaveBeenCalledWith({
      tenantId: TENANT,
      profileId: undefined,
      profileSlug: undefined,
      fromNumber: '+15551112222',
    });
    expect(harness.twilioProvider.sendMessage).toHaveBeenCalled();
  });

  it('AMBIGUOUS_FROM_NUMBER from resolver propagates as RoutingError', async () => {
    const harness = makeService();
    harness.resolveOutbound.resolve.mockRejectedValue(
      new RoutingError(
        RoutingErrorCode.AMBIGUOUS_FROM_NUMBER,
        'fromNumber is shared by 2 profiles',
      ),
    );

    await expect(
      harness.service.sendMessageToPhoneNumber(
        WS, '+15551112222', '+19998887777', 'hi', 'sms', TENANT, undefined, undefined, {},
      ),
    ).rejects.toMatchObject({
      name: 'RoutingError',
      code: RoutingErrorCode.AMBIGUOUS_FROM_NUMBER,
    });
    expect(harness.twilioProvider.sendMessage).not.toHaveBeenCalled();
  });

  it('CROSS_TENANT_PROFILE propagates and blocks the send', async () => {
    const harness = makeService();
    harness.resolveOutbound.resolve.mockRejectedValue(
      new RoutingError(
        RoutingErrorCode.CROSS_TENANT_PROFILE,
        'profile belongs to another tenant',
      ),
    );

    await expect(
      harness.service.sendMessageToPhoneNumber(
        WS, '', '+19998887777', 'hi', 'sms', TENANT, undefined, undefined,
        { profileId: 'wrong-tenant-profile' },
      ),
    ).rejects.toMatchObject({ code: RoutingErrorCode.CROSS_TENANT_PROFILE });
    expect(harness.twilioProvider.sendMessage).not.toHaveBeenCalled();
  });

  it('PROFILE_NOT_CONFIGURED propagates (HF case — profile with no phone)', async () => {
    const harness = makeService();
    harness.resolveOutbound.resolve.mockRejectedValue(
      new RoutingError(
        RoutingErrorCode.PROFILE_NOT_CONFIGURED,
        'profile has no active phone assignment',
      ),
    );

    await expect(
      harness.service.sendMessageToPhoneNumber(
        WS, '', '+19998887777', 'hi', 'sms', TENANT, undefined, undefined,
        { profileId: PROFILE_ID },
      ),
    ).rejects.toMatchObject({ code: RoutingErrorCode.PROFILE_NOT_CONFIGURED });
  });

  it('falls back to phoneNumberId direct path when resolver INVALID_PROFILE_PHONE + phoneNumberId provided', async () => {
    const harness = makeService();
    harness.resolveOutbound.resolve.mockRejectedValue(
      new RoutingError(
        RoutingErrorCode.INVALID_PROFILE_PHONE,
        'phone not in profile assignments',
      ),
    );
    // Existing OpenPhone fallback path
    harness.tenantIntegrationRepo.findOne.mockResolvedValue(null);
    harness.integrationRepo.findOne.mockResolvedValue({
      id: 'int-op',
      workspaceId: WS,
      provider: ProviderType.OPENPHONE,
      status: IntegrationStatus.ACTIVE,
      credentialsEncrypted: 'enc',
    });
    harness.tenantPhoneNumberRepo.findOne.mockResolvedValue(null); // not in tpn
    harness.conversationRepo.findOne.mockResolvedValue(null);
    harness.openPhoneProvider.sendMessage.mockResolvedValue({
      providerMessageId: 'msg-1',
      status: 'sent',
    });

    await harness.service.sendMessageToPhoneNumber(
      WS, '+15553334444', '+19998887777', 'hello', 'sms', TENANT,
      'PNxxx', // phoneNumberId triggers the OpenPhone fallback
      undefined,
      {},
    );

    expect(harness.openPhoneProvider.sendMessage).toHaveBeenCalled();
    // No profile tag (since resolver failed and fallback chose by phoneNumberId)
    const savedConversations = harness.conversationRepo.save.mock.calls.map((c: any[]) => c[0]);
    const tagged = savedConversations.find((c: any) => c.communicationProfileId);
    expect(tagged).toBeUndefined();
  });

  it('does NOT call resolver when neither profileId/Slug nor fromNumber is given (legacy path with phoneNumberId)', async () => {
    const harness = makeService();
    // No fromNumber, but phoneNumberId provided — pure legacy OpenPhone direct send
    harness.tenantIntegrationRepo.findOne.mockResolvedValue(null);
    harness.integrationRepo.findOne.mockResolvedValue({
      id: 'int-op',
      workspaceId: WS,
      provider: ProviderType.OPENPHONE,
      status: IntegrationStatus.ACTIVE,
      credentialsEncrypted: 'enc',
    });
    harness.tenantPhoneNumberRepo.findOne.mockResolvedValue(null);
    harness.conversationRepo.findOne.mockResolvedValue(null);
    harness.openPhoneProvider.sendMessage.mockResolvedValue({
      providerMessageId: 'msg-2',
      status: 'sent',
    });

    await harness.service.sendMessageToPhoneNumber(
      WS, '', '+19998887777', 'hello', 'sms', TENANT, 'PNxxx', undefined, {},
    );

    expect(harness.resolveOutbound.resolve).not.toHaveBeenCalled();
    expect(harness.openPhoneProvider.sendMessage).toHaveBeenCalled();
  });
});
