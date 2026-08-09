import { CommunicationService } from './communication.service';
import { ProviderType, IntegrationStatus } from '../../database/entities/communication-integration.entity';
import { PhoneNumberProvider } from '../../database/entities/tenant-phone-number.entity';
import { ForbiddenException, NotFoundException } from '@nestjs/common';

// ---------------------------------------------------------------------------
// Mock builders (same pattern as call-connect.service.spec.ts)
// ---------------------------------------------------------------------------
function buildMockRepo() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((data: any) => ({ ...data })),
    save: jest.fn(async (entity: any) => entity),
    remove: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
    createQueryBuilder: jest.fn(),
    update: jest.fn(),
    // Raw SQL escape hatch used by the route-by-phone authorization in
    // `findConversationForTenant` (#47). Default: no phones allowed —
    // tests that need the caller to be authorized override this.
    query: jest.fn().mockResolvedValue([]),
  };
}

/**
 * Default PPA query-builder mock that returns null for `getRawOne` — i.e.
 * "no shared assignment exists." Cross-tenant guard tests rely on this
 * default to fall through to the 403 path. Tests that need to simulate an
 * active shared PPA override `createQueryBuilder` on `ppaRepo`.
 */
function buildPpaQbDefault(getRawOneResult: unknown = null) {
  return {
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue(getRawOneResult),
  };
}

function buildService() {
  const integrationRepo = buildMockRepo();
  const tenantIntegrationRepo = buildMockRepo();
  const conversationRepo = buildMockRepo();
  const messageRepo = buildMockRepo();
  const callRepo = buildMockRepo();
  const senderRepo = buildMockRepo();
  const tenantPhoneNumberRepo = buildMockRepo();
  const ppaRepo = buildMockRepo();
  ppaRepo.createQueryBuilder.mockReturnValue(buildPpaQbDefault(null));
  const openPhoneProvider = { sendMessage: jest.fn() };
  const twilioProvider = { sendMessage: jest.fn() };
  const whatsappWebProvider = { sendMessage: jest.fn() };
  const encryptionService = { decrypt: jest.fn().mockReturnValue('decrypted-creds'), encrypt: jest.fn() };
  const openPhoneContactCache = {
    upsertParticipantFromConversation: jest.fn(),
    sniffProviderAccountId: jest.fn().mockResolvedValue(''),
  };

  const service = new CommunicationService(
    integrationRepo as any,
    tenantIntegrationRepo as any,
    conversationRepo as any,
    messageRepo as any,
    callRepo as any,
    senderRepo as any,
    tenantPhoneNumberRepo as any,
    ppaRepo as any,
    openPhoneProvider as any,
    twilioProvider as any,
    whatsappWebProvider as any,
    encryptionService as any,
    openPhoneContactCache as any,
  );

  return {
    service,
    integrationRepo,
    tenantIntegrationRepo,
    conversationRepo,
    messageRepo,
    callRepo,
    senderRepo,
    tenantPhoneNumberRepo,
    ppaRepo,
    openPhoneProvider,
    twilioProvider,
    encryptionService,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const WS_ID = 'ws-1';
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

function makeConversation(overrides: Record<string, any> = {}) {
  return {
    id: 'conv-1',
    workspaceId: WS_ID,
    tenantId: null,
    externalId: 'ext-1',
    provider: ProviderType.OPENPHONE,
    phoneNumber: '+15551234567',
    participantPhoneNumber: '+15559876543',
    participantPhoneNumbers: null,
    metadata: {},
    channel: 'sms',
    contactId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tenant Isolation Tests
// ---------------------------------------------------------------------------
describe('CommunicationService – Tenant Isolation', () => {
  describe('getConversations', () => {
    function setupQueryBuilder(conversations: any[], total: number) {
      const qb = {
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(conversations),
        getCount: jest.fn().mockResolvedValue(total),
        getRawMany: jest.fn().mockResolvedValue([]),
      };
      return qb;
    }

    /**
     * Post-#47 contract: tenant-scoped reads authorize via the caller's
     * OWNED phones (`tenant_phone_numbers` rows) UNION their PPA-shared
     * phones (`profile_phone_assignments.active = TRUE`). The
     * `conv.tenantId = :tenantId` column filter that previously held
     * this responsibility was removed — it silently hid ~92% of
     * Spotless Homes Jacksonville's conversations when sibling sub-
     * tenants happened to sync the workspace first and grabbed the tag.
     */
    it('routes by phone ownership (owned UNION PPA-shared) when tenant-scoped', async () => {
      const { service, conversationRepo, messageRepo } = buildService();
      const convA = makeConversation({ id: 'conv-a', tenantId: TENANT_A });
      const qb = setupQueryBuilder([convA], 1);
      conversationRepo.createQueryBuilder.mockReturnValue(qb);
      conversationRepo.count.mockResolvedValue(1);
      conversationRepo.find.mockResolvedValue([convA]);
      messageRepo.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      });

      await service.getConversations(WS_ID, { tenantId: TENANT_A });

      const andWhereCalls = qb.andWhere.mock.calls.map((c: any) => c[0]);
      // No `conv.tenantId = :tenantId` — that was the #47 bug.
      expect(andWhereCalls).not.toContain('conv.tenantId = :tenantId');
      // The route-by-phone filter references the two ownership sources
      // that constitute "phones this tenant can send/receive on."
      const combined = andWhereCalls.join('\n');
      expect(combined).toContain('conv.phone_number IN');
      expect(combined).toContain('tenant_phone_numbers');
      expect(combined).toContain('profile_phone_assignments');
      // Parameters are wired via the second andWhere arg
      const params = qb.andWhere.mock.calls
        .map((c: any) => c[1])
        .find((p: any) => p && 'tenantId' in p);
      expect(params).toEqual({ workspaceId: WS_ID, tenantId: TENANT_A });
    });

    it('does NOT apply the phone-ownership filter for workspace-scoped keys', async () => {
      const { service, conversationRepo, messageRepo } = buildService();
      const qb = setupQueryBuilder([], 0);
      conversationRepo.createQueryBuilder.mockReturnValue(qb);
      conversationRepo.count.mockResolvedValue(0);
      messageRepo.createQueryBuilder.mockReturnValue({
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      });

      await service.getConversations(WS_ID, { tenantId: null });

      const andWhereCalls = qb.andWhere.mock.calls.map((c: any) => c[0]).join('\n');
      // Neither the old tenant_id filter nor the new phone-in filter.
      expect(andWhereCalls).not.toContain('conv.tenantId = :tenantId');
      expect(andWhereCalls).not.toContain('conv.phone_number IN');
    });
  });

  describe('getMessagesForConversation – tenant enforcement', () => {
    function mockConvQueryBuilder(conversations: any[]) {
      return {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(conversations),
      };
    }

    function mockMsgQueryBuilder(messages: any[]) {
      return {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(messages),
      };
    }

    /**
     * Post-#47 contract: the tenant check on per-conversation reads
     * (messages, calls) uses the same route-by-phone authorization as
     * `getConversations`. The conversation is loaded without a
     * `tenantId` where-clause, then a raw SQL UNION over
     * `tenant_phone_numbers` + `profile_phone_assignments` decides
     * whether the caller's tenant owns or has-PPA-to the conversation's
     * `phone_number`. Prior tests pinned the old contract
     * (`findOne({ tenantId })`) and are updated to the new one here.
     */
    it('returns messages when conversation phone is owned by the tenant', async () => {
      const { service, conversationRepo, messageRepo } = buildService();
      const conv = makeConversation({ id: 'conv-1', phoneNumber: '+15551234567', tenantId: TENANT_B });
      conversationRepo.findOne.mockResolvedValue(conv);
      // Simulate tenant A owning that phone number (owned branch of the UNION).
      conversationRepo.query.mockResolvedValue([{ phone_number: '+15551234567' }]);
      conversationRepo.createQueryBuilder.mockReturnValue(mockConvQueryBuilder([conv]));
      messageRepo.createQueryBuilder.mockReturnValue(mockMsgQueryBuilder([{ id: 'msg-1', body: 'hello', conversationId: 'conv-1' }]));

      const messages = await service.getMessagesForConversation(WS_ID, 'conv-1', TENANT_A);
      expect(messages).toHaveLength(1);
      // findOne no longer takes tenantId in the where — the tenant-id column on
      // conv can point at a sibling tenant, as it does in prod for Spotless.
      expect(conversationRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'conv-1', workspaceId: WS_ID },
      });
      // Authorization went through the phones UNION.
      expect(conversationRepo.query).toHaveBeenCalledWith(
        expect.stringContaining('profile_phone_assignments'),
        [WS_ID, TENANT_A],
      );
    });

    it('throws NotFoundException when the tenant owns no matching phone (nor has an active PPA)', async () => {
      const { service, conversationRepo } = buildService();
      const conv = makeConversation({ id: 'conv-1', phoneNumber: '+15559999999', tenantId: TENANT_B });
      conversationRepo.findOne.mockResolvedValue(conv);
      // Tenant A owns different phones; conv's phone isn't in the allow-set.
      conversationRepo.query.mockResolvedValue([{ phone_number: '+15551110000' }]);

      await expect(
        service.getMessagesForConversation(WS_ID, 'conv-1', TENANT_A),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when the conversation row does not exist at all', async () => {
      const { service, conversationRepo } = buildService();
      conversationRepo.findOne.mockResolvedValue(null);

      await expect(
        service.getMessagesForConversation(WS_ID, 'conv-1', TENANT_A),
      ).rejects.toThrow(NotFoundException);
      // Never got as far as the PPA lookup — the row itself is missing.
      expect(conversationRepo.query).not.toHaveBeenCalled();
    });

    it('returns messages without any tenant check for workspace-scoped callers', async () => {
      const { service, conversationRepo, messageRepo } = buildService();
      const conv = makeConversation({ id: 'conv-1', tenantId: TENANT_A });
      conversationRepo.findOne.mockResolvedValue(conv);
      conversationRepo.createQueryBuilder.mockReturnValue(mockConvQueryBuilder([conv]));
      messageRepo.createQueryBuilder.mockReturnValue(mockMsgQueryBuilder([{ id: 'msg-1', body: 'hello', conversationId: 'conv-1' }]));

      const messages = await service.getMessagesForConversation(WS_ID, 'conv-1', null);
      expect(messages).toHaveLength(1);
      // Workspace-scoped callers skip the phones-UNION query entirely.
      expect(conversationRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'conv-1', workspaceId: WS_ID },
      });
      expect(conversationRepo.query).not.toHaveBeenCalled();
    });
  });

  describe('getCallsForConversation – tenant enforcement', () => {
    it('throws NotFoundException when the tenant owns no matching phone', async () => {
      const { service, conversationRepo } = buildService();
      const conv = makeConversation({ id: 'conv-1', phoneNumber: '+15559999999', tenantId: TENANT_B });
      conversationRepo.findOne.mockResolvedValue(conv);
      conversationRepo.query.mockResolvedValue([]); // no allowed phones

      await expect(
        service.getCallsForConversation(WS_ID, 'conv-1', TENANT_A),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when the conversation row does not exist', async () => {
      const { service, conversationRepo } = buildService();
      conversationRepo.findOne.mockResolvedValue(null);

      await expect(
        service.getCallsForConversation(WS_ID, 'conv-1', TENANT_A),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('sendMessageToPhoneNumber – tenant tagging', () => {
    it('tags new Twilio conversation with tenantId', async () => {
      const { service, conversationRepo, messageRepo, integrationRepo, tenantPhoneNumberRepo, twilioProvider } = buildService();

      // Phone number belongs to tenant as Twilio
      tenantPhoneNumberRepo.findOne.mockResolvedValue({
        phoneNumber: '+15551234567',
        provider: PhoneNumberProvider.TWILIO,
        tenantId: TENANT_A,
      });

      // integrationRepo.findOne is called once: for Twilio at line 710
      integrationRepo.findOne.mockResolvedValue({
        provider: ProviderType.TWILIO,
        status: IntegrationStatus.ACTIVE,
        credentialsEncrypted: 'encrypted',
      });

      // No existing conversation
      conversationRepo.findOne.mockResolvedValue(null);

      twilioProvider.sendMessage.mockResolvedValue({
        providerMessageId: 'SM123',
        status: 'sent',
      });
      messageRepo.create.mockImplementation((data: any) => data);
      messageRepo.save.mockImplementation(async (m: any) => m);

      await service.sendMessageToPhoneNumber(
        WS_ID, '+15551234567', '+15559876543', 'Hello', 'sms', TENANT_A,
      );

      // Verify conversation was created with tenantId
      expect(conversationRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT_A }),
      );
    });

    it('backfills tenantId on existing conversation without one', async () => {
      const { service, conversationRepo, messageRepo, integrationRepo, tenantPhoneNumberRepo, twilioProvider } = buildService();

      tenantPhoneNumberRepo.findOne.mockResolvedValue({
        phoneNumber: '+15551234567',
        provider: PhoneNumberProvider.TWILIO,
        tenantId: TENANT_A,
      });

      integrationRepo.findOne.mockResolvedValue({
        provider: ProviderType.TWILIO,
        status: IntegrationStatus.ACTIVE,
        credentialsEncrypted: 'encrypted',
      });

      // Existing conversation without tenantId
      const existingConv = makeConversation({ tenantId: null, provider: ProviderType.TWILIO });
      conversationRepo.findOne.mockResolvedValue(existingConv);

      twilioProvider.sendMessage.mockResolvedValue({
        providerMessageId: 'SM456',
        status: 'sent',
      });
      messageRepo.create.mockImplementation((data: any) => data);
      messageRepo.save.mockImplementation(async (m: any) => m);

      await service.sendMessageToPhoneNumber(
        WS_ID, '+15551234567', '+15559876543', 'Hello', 'sms', TENANT_A,
      );

      // Verify tenantId was backfilled
      expect(conversationRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT_A }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Fix A — readiness-report 2026-05-08: cross-tenant `fromNumber` guard.
  //
  // Before this fix, sendMessageToPhoneNumber's tenant_phone_numbers lookup
  // was workspace-scoped only — tenant A could specify tenant B's dedicated
  // number as `fromNumber` and the routing would happily go through B's
  // provider/credentials. The fix rejects with ForbiddenException when the
  // resolved TPN's tenant_id does not match the caller's tenant key.
  // -------------------------------------------------------------------------
  describe('sendMessageToPhoneNumber – cross-tenant fromNumber guard (Fix A)', () => {
    it('throws ForbiddenException when the TPN belongs to a different tenant', async () => {
      const { service, tenantPhoneNumberRepo, integrationRepo, twilioProvider } = buildService();

      // The fromNumber is registered to TENANT_B in tenant_phone_numbers.
      tenantPhoneNumberRepo.findOne.mockResolvedValue({
        id: 'tpn-b-1',
        phoneNumber: '+15551234567',
        provider: PhoneNumberProvider.TWILIO,
        tenantId: TENANT_B,
      });

      // The caller's API key is scoped to TENANT_A.
      await expect(
        service.sendMessageToPhoneNumber(
          WS_ID, '+15551234567', '+15559876543', 'Hello', 'sms', TENANT_A,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // The provider must NOT be invoked when the guard rejects.
      expect(twilioProvider.sendMessage).not.toHaveBeenCalled();
      // No fallback Twilio integration lookup should occur after the rejection.
      expect(integrationRepo.findOne).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException for OpenPhone-backed TPN owned by another tenant', async () => {
      const { service, tenantPhoneNumberRepo, openPhoneProvider, tenantIntegrationRepo, integrationRepo } = buildService();

      tenantPhoneNumberRepo.findOne.mockResolvedValue({
        id: 'tpn-b-2',
        phoneNumber: '+15551234567',
        provider: PhoneNumberProvider.OPENPHONE,
        tenantId: TENANT_B,
      });

      await expect(
        service.sendMessageToPhoneNumber(
          WS_ID, '+15551234567', '+15559876543', 'Hello', 'sms', TENANT_A,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(openPhoneProvider.sendMessage).not.toHaveBeenCalled();
      // Neither integration lookup should happen — guard fires before routing.
      expect(tenantIntegrationRepo.findOne).not.toHaveBeenCalled();
      expect(integrationRepo.findOne).not.toHaveBeenCalled();
    });

    it('permits send when the TPN belongs to the calling tenant (Twilio)', async () => {
      const { service, conversationRepo, messageRepo, integrationRepo, tenantPhoneNumberRepo, twilioProvider } = buildService();

      tenantPhoneNumberRepo.findOne.mockResolvedValue({
        id: 'tpn-a-1',
        phoneNumber: '+15551234567',
        provider: PhoneNumberProvider.TWILIO,
        tenantId: TENANT_A,
      });
      integrationRepo.findOne.mockResolvedValue({
        provider: ProviderType.TWILIO,
        status: IntegrationStatus.ACTIVE,
        credentialsEncrypted: 'encrypted',
      });
      conversationRepo.findOne.mockResolvedValue(null);
      twilioProvider.sendMessage.mockResolvedValue({ providerMessageId: 'SM-OK', status: 'sent' });
      messageRepo.create.mockImplementation((data: any) => data);
      messageRepo.save.mockImplementation(async (m: any) => m);

      await expect(
        service.sendMessageToPhoneNumber(
          WS_ID, '+15551234567', '+15559876543', 'Hello', 'sms', TENANT_A,
        ),
      ).resolves.toBeDefined();
      expect(twilioProvider.sendMessage).toHaveBeenCalledTimes(1);
    });

    // -----------------------------------------------------------------------
    // Shared-assignment amendment (2026-05-11). Cross-tenant TPN sends are
    // permitted when an active profile_phone_assignment links the TPN to an
    // active profile under the caller's tenant. This unblocks the Yelp JAX
    // case where +19045778584 is owned by tenant Thumbtack JAX but assigned
    // to a profile under tenant Yelp JAX via PR15's shared-assignment model.
    // -----------------------------------------------------------------------
    it('permits cross-tenant send when an active PPA links the TPN to a profile under the caller tenant', async () => {
      const {
        service, conversationRepo, messageRepo, integrationRepo,
        tenantPhoneNumberRepo, ppaRepo, twilioProvider,
      } = buildService();

      // TPN is owned by TENANT_B (Thumbtack JAX), but PPA links it to a
      // profile under TENANT_A (Yelp JAX) — caller is TENANT_A.
      tenantPhoneNumberRepo.findOne.mockResolvedValue({
        id: 'tpn-shared',
        phoneNumber: '+15551234567',
        provider: PhoneNumberProvider.TWILIO,
        tenantId: TENANT_B,
      });
      const sharedQb = buildPpaQbDefault({ id: 'ppa-active', profile_id: 'profile-yelp-jax' });
      ppaRepo.createQueryBuilder.mockReturnValue(sharedQb);
      integrationRepo.findOne.mockResolvedValue({
        provider: ProviderType.TWILIO,
        status: IntegrationStatus.ACTIVE,
        credentialsEncrypted: 'encrypted',
      });
      conversationRepo.findOne.mockResolvedValue(null);
      twilioProvider.sendMessage.mockResolvedValue({ providerMessageId: 'SM-SHARED', status: 'sent' });
      messageRepo.create.mockImplementation((data: any) => data);
      messageRepo.save.mockImplementation(async (m: any) => m);

      await expect(
        service.sendMessageToPhoneNumber(
          WS_ID, '+15551234567', '+15559876543', 'Hello', 'sms', TENANT_A,
        ),
      ).resolves.toBeDefined();

      // Provider should fire; the guard let the send through.
      expect(twilioProvider.sendMessage).toHaveBeenCalledTimes(1);
      // The PPA lookup must have been issued exactly once.
      expect(ppaRepo.createQueryBuilder).toHaveBeenCalledWith('ppa');

      // Defense-in-depth: the PPA query must be workspace-scoped and tenant-
      // scoped against the caller, AND filter only active PPAs + profiles.
      const andWhereCalls = sharedQb.andWhere.mock.calls.map((c: any[]) => ({ sql: c[0], params: c[1] }));
      expect(andWhereCalls).toEqual(
        expect.arrayContaining([
          { sql: 'ppa.active = TRUE', params: undefined },
          { sql: 'p.workspace_id = :workspaceId', params: { workspaceId: WS_ID } },
          { sql: 'p.tenant_id = :callerTenant', params: { callerTenant: TENANT_A } },
          { sql: "p.status = 'active'", params: undefined },
        ]),
      );
      expect(sharedQb.where).toHaveBeenCalledWith(
        'ppa.tenant_phone_number_id = :tpnId',
        { tpnId: 'tpn-shared' },
      );
    });

    it('rejects cross-tenant send when the matching PPA is inactive', async () => {
      const {
        service, integrationRepo, tenantPhoneNumberRepo, ppaRepo, twilioProvider,
      } = buildService();

      tenantPhoneNumberRepo.findOne.mockResolvedValue({
        id: 'tpn-shared-inactive',
        phoneNumber: '+15551234567',
        provider: PhoneNumberProvider.TWILIO,
        tenantId: TENANT_B,
      });
      // Service's QB filters `ppa.active = TRUE` AND `p.status = 'active'`, so
      // an inactive PPA (or an inactive parent profile) yields no row — the
      // query returns null and the guard rejects with 403.
      ppaRepo.createQueryBuilder.mockReturnValue(buildPpaQbDefault(null));

      await expect(
        service.sendMessageToPhoneNumber(
          WS_ID, '+15551234567', '+15559876543', 'Hello', 'sms', TENANT_A,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(twilioProvider.sendMessage).not.toHaveBeenCalled();
      expect(integrationRepo.findOne).not.toHaveBeenCalled();
    });

    it('does NOT consult tenant_phone_numbers for workspace-scoped callers (guard skipped by design)', async () => {
      // Workspace operators bypass the per-tenant routing block entirely —
      // by design. The TPN lookup lives inside `if (tenantId) { ... }`, so a
      // call with no tenantId never hits the guard. The downstream workspace
      // path is exercised by separate integration tests; here we only assert
      // that the guard is not over-applied (would block legitimate workspace
      // sends if it leaked outside the tenant block).
      const { service, tenantPhoneNumberRepo, integrationRepo, ppaRepo } = buildService();

      // Force the workspace fallback path to throw early so we don't have
      // to wire up the full Twilio/OpenPhone matcher. The throw is fine —
      // we only care that the TPN lookup was not invoked.
      integrationRepo.findOne.mockResolvedValue(null);

      await expect(
        service.sendMessageToPhoneNumber(
          WS_ID, '+15551234567', '+15559876543', 'Hello', 'sms', /* tenantId */ undefined,
        ),
      ).rejects.toThrow(/No active integration/);

      // The point of this test: the cross-tenant guard never ran because
      // tenantId was undefined. Neither the TPN ownership check nor the
      // shared-PPA lookup should fire for workspace-scoped callers.
      expect(tenantPhoneNumberRepo.findOne).not.toHaveBeenCalled();
      expect(ppaRepo.createQueryBuilder).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Paginated getMessagesForConversation with cursor
// ---------------------------------------------------------------------------
describe('CommunicationService – Paginated messages with cursor', () => {
  function mockConvQueryBuilder(conversations: any[]) {
    return {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(conversations),
    };
  }

  function mockMsgQueryBuilder(messages: any[]) {
    return {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(messages),
    };
  }

  it('applies before cursor as andWhere on msg.created_at', async () => {
    const { service, conversationRepo, messageRepo } = buildService();
    const conv = makeConversation({ id: 'conv-1' });
    conversationRepo.findOne.mockResolvedValue(conv);
    conversationRepo.createQueryBuilder.mockReturnValue(mockConvQueryBuilder([conv]));

    const msgQb = mockMsgQueryBuilder([
      { id: 'msg-old', body: 'older', conversationId: 'conv-1', createdAt: new Date('2026-04-01') },
    ]);
    messageRepo.createQueryBuilder.mockReturnValue(msgQb);

    const beforeTimestamp = '2026-04-05T00:00:00Z';
    const messages = await service.getMessagesForConversation(WS_ID, 'conv-1', null, {
      before: beforeTimestamp,
      limit: 20,
    });

    // Should apply andWhere for cursor
    expect(msgQb.andWhere).toHaveBeenCalledWith(
      'msg.created_at < :before',
      { before: new Date(beforeTimestamp) },
    );
    // Should apply take with the requested limit
    expect(msgQb.take).toHaveBeenCalledWith(20);
    // Should order DESC
    expect(msgQb.orderBy).toHaveBeenCalledWith('msg.created_at', 'DESC');
    expect(messages).toHaveLength(1);
  });

  it('defaults to 30 messages when no limit specified', async () => {
    const { service, conversationRepo, messageRepo } = buildService();
    const conv = makeConversation({ id: 'conv-1' });
    conversationRepo.findOne.mockResolvedValue(conv);
    conversationRepo.createQueryBuilder.mockReturnValue(mockConvQueryBuilder([conv]));

    const msgQb = mockMsgQueryBuilder([]);
    messageRepo.createQueryBuilder.mockReturnValue(msgQb);

    await service.getMessagesForConversation(WS_ID, 'conv-1', null);

    // Default limit = 30
    expect(msgQb.take).toHaveBeenCalledWith(30);
  });

  it('does NOT apply before cursor when not provided', async () => {
    const { service, conversationRepo, messageRepo } = buildService();
    const conv = makeConversation({ id: 'conv-1' });
    conversationRepo.findOne.mockResolvedValue(conv);
    conversationRepo.createQueryBuilder.mockReturnValue(mockConvQueryBuilder([conv]));

    const msgQb = mockMsgQueryBuilder([]);
    messageRepo.createQueryBuilder.mockReturnValue(msgQb);

    await service.getMessagesForConversation(WS_ID, 'conv-1', null, { limit: 10 });

    // andWhere should only be called by the conversation filter (from where clause), not for cursor
    // The only andWhere call would be for participant phones
    const andWhereCalls = msgQb.andWhere.mock.calls;
    const hasCursorFilter = andWhereCalls.some(
      (call: any) => typeof call[0] === 'string' && call[0].includes('created_at'),
    );
    expect(hasCursorFilter).toBe(false);
  });

  it('returns messages in chronological order (reversed from DESC query)', async () => {
    const { service, conversationRepo, messageRepo } = buildService();
    const conv = makeConversation({ id: 'conv-1' });
    conversationRepo.findOne.mockResolvedValue(conv);
    conversationRepo.createQueryBuilder.mockReturnValue(mockConvQueryBuilder([conv]));

    // Simulate DB returning DESC order (newest first)
    const msgQb = mockMsgQueryBuilder([
      { id: 'msg-3', body: 'newest', createdAt: new Date('2026-04-03') },
      { id: 'msg-2', body: 'middle', createdAt: new Date('2026-04-02') },
      { id: 'msg-1', body: 'oldest', createdAt: new Date('2026-04-01') },
    ]);
    messageRepo.createQueryBuilder.mockReturnValue(msgQb);

    const messages = await service.getMessagesForConversation(WS_ID, 'conv-1', null);

    // Should be reversed to chronological order
    expect(messages[0].id).toBe('msg-1');
    expect(messages[1].id).toBe('msg-2');
    expect(messages[2].id).toBe('msg-3');
  });

  it('applies both before cursor and limit together for pagination', async () => {
    const { service, conversationRepo, messageRepo } = buildService();
    const conv = makeConversation({ id: 'conv-1' });
    conversationRepo.findOne.mockResolvedValue(conv);
    conversationRepo.createQueryBuilder.mockReturnValue(mockConvQueryBuilder([conv]));

    const msgQb = mockMsgQueryBuilder([]);
    messageRepo.createQueryBuilder.mockReturnValue(msgQb);

    const beforeTs = '2026-04-08T12:00:00Z';
    await service.getMessagesForConversation(WS_ID, 'conv-1', null, {
      before: beforeTs,
      limit: 15,
    });

    expect(msgQb.andWhere).toHaveBeenCalledWith(
      'msg.created_at < :before',
      { before: new Date(beforeTs) },
    );
    expect(msgQb.take).toHaveBeenCalledWith(15);
    expect(msgQb.orderBy).toHaveBeenCalledWith('msg.created_at', 'DESC');
  });

  it('throws NotFoundException when conversation does not exist', async () => {
    const { service, conversationRepo } = buildService();
    conversationRepo.findOne.mockResolvedValue(null);

    await expect(
      service.getMessagesForConversation(WS_ID, 'conv-nonexistent', null, {
        before: '2026-04-08T12:00:00Z',
        limit: 10,
      }),
    ).rejects.toThrow(NotFoundException);
  });
});

// ---------------------------------------------------------------------------
// SyncOptions tenantId
// ---------------------------------------------------------------------------
describe('CommunicationService – SyncOptions.tenantId', () => {
  it('SyncOptions interface accepts tenantId', () => {
    // Type-level test: just verify the interface shape compiles
    const options: import('./communication.service').SyncOptions = {
      tenantId: 'tenant-123',
      provider: ProviderType.OPENPHONE,
    };
    expect(options.tenantId).toBe('tenant-123');
  });
});
