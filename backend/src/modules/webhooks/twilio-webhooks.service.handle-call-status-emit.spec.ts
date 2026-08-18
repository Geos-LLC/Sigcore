/**
 * 2026-08-17 — TwilioWebhooksService.handleCallStatus MUST fire a
 * CALL_COMPLETED / CALL_MISSED outbound event to subscribers when a
 * Twilio call status callback lands. Historically it only mutated the
 * DB row, so tenant-scoped subscriptions (Callio's /api/webhooks/sigcore,
 * Service Flow's, etc.) never received any call event for calls that
 * completed via the tenant-forward flow.
 *
 * Scope derivation is load-bearing here: without the tenant scope the
 * fan-out in OutboundWebhooksService.loadMatchingSubscriptions filters
 * out every tenant-scoped subscription (they require
 * `scope.tenantId === sub.tenantId`).
 */
import { TwilioWebhooksService } from './twilio-webhooks.service';
import { CallStatus, CallDirection } from '../../database/entities/communication-call.entity';
import { WebhookEventType } from '../../database/entities/webhook-subscription.entity';

const CALL_SID = 'CA55f6272f39e84082f29d729c75a81170';
const CALL_ROW_ID = 'call-1';
const WORKSPACE_ID = '1bcbb4e0-df1b-481c-83ba-0730df47a720';
const TENANT_ID = '3c74068e-beec-4758-8720-631a9dc4e134';
const OUR_NUMBER = '+17869050302';
const CALLER_NUMBER = '+12483462681';

function repo() {
  return {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(async (row: any) => row),
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

function buildSvc(overrides: {
  callStatusFromDb?: CallStatus;
  conversationTenantId?: string | null;
  tpnTenantId?: string | null;
  conversationExists?: boolean;
  businessId?: string | null;
  profileId?: string | null;
  outboundWired?: boolean;
} = {}) {
  const conversationRepo = repo();
  const messageRepo = repo();
  const callRepo = repo();
  const integrationRepo = repo();
  const workspaceRepo = repo();
  const tenantPhoneNumberRepo = repo();
  const tenantRepo = repo();
  const ccSettingsRepo = repo();

  // The saved call row that handleCallStatus sees after applying the
  // status update. Direction=IN + toNumber=OUR_NUMBER match the
  // Callio-inbound flow.
  callRepo.findOne.mockResolvedValue({
    id: CALL_ROW_ID,
    conversationId: 'conv-1',
    providerCallId: CALL_SID,
    direction: CallDirection.IN,
    duration: 0,
    fromNumber: CALLER_NUMBER,
    toNumber: OUR_NUMBER,
    status: CallStatus.COMPLETED,
    recordingUrl: null,
    voicemailUrl: null,
    startedAt: null,
    endedAt: null,
    metadata: {},
  });

  if (overrides.conversationExists === false) {
    conversationRepo.findOne.mockResolvedValue(null);
  } else {
    conversationRepo.findOne.mockResolvedValue({
      id: 'conv-1',
      workspaceId: WORKSPACE_ID,
      tenantId: overrides.conversationTenantId ?? null,
      communicationBusinessId: overrides.businessId ?? null,
      communicationProfileId: overrides.profileId ?? null,
    });
  }

  if (overrides.tpnTenantId === undefined) {
    tenantPhoneNumberRepo.findOne.mockResolvedValue({
      id: 'tpn-1',
      workspaceId: WORKSPACE_ID,
      phoneNumber: OUR_NUMBER,
      tenantId: TENANT_ID,
    });
  } else if (overrides.tpnTenantId === null) {
    tenantPhoneNumberRepo.findOne.mockResolvedValue(null);
  } else {
    tenantPhoneNumberRepo.findOne.mockResolvedValue({
      id: 'tpn-1',
      workspaceId: WORKSPACE_ID,
      phoneNumber: OUR_NUMBER,
      tenantId: overrides.tpnTenantId,
    });
  }

  const encryptionService = { decrypt: jest.fn() } as any;
  const eventsGateway = {} as any;
  const configService = { get: jest.fn() } as any;
  const idempotencyService = {} as any;
  const outboundWebhooksService = {
    emitEvent: jest.fn(async () => undefined),
  } as any;

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
    undefined, // tenantWebhooksService (@Optional)
    overrides.outboundWired === false ? undefined : outboundWebhooksService,
  );
  return {
    svc,
    conversationRepo,
    callRepo,
    tenantPhoneNumberRepo,
    outboundWebhooksService,
  };
}

describe('TwilioWebhooksService.handleCallStatus — fires outbound webhook event', () => {
  it('emits CALL_COMPLETED with tenant scope from TPN on status=completed', async () => {
    const { svc, outboundWebhooksService } = buildSvc();

    await svc.handleCallStatus({
      CallSid: CALL_SID,
      CallStatus: 'completed',
      CallDuration: '8',
    } as any);

    // Wait a microtask so the fire-and-forget .catch chain settles.
    await new Promise((r) => setImmediate(r));

    expect(outboundWebhooksService.emitEvent).toHaveBeenCalledTimes(1);
    const [wsId, eventType, data, scope] =
      outboundWebhooksService.emitEvent.mock.calls[0];
    expect(wsId).toBe(WORKSPACE_ID);
    expect(eventType).toBe(WebhookEventType.CALL_COMPLETED);
    expect(scope).toEqual({
      tenantId: TENANT_ID,
      businessId: undefined,
      profileId: undefined,
    });
    expect(data.callId).toBe(CALL_ROW_ID);
    expect(data.providerCallId).toBe(CALL_SID);
    expect(data.status).toBe(CallStatus.COMPLETED);
    expect(data.duration).toBe(8);
    expect(data.fromNumber).toBe(CALLER_NUMBER);
    expect(data.toNumber).toBe(OUR_NUMBER);
  });

  it('emits CALL_MISSED on status=no-answer', async () => {
    const { svc, outboundWebhooksService } = buildSvc();
    await svc.handleCallStatus({
      CallSid: CALL_SID,
      CallStatus: 'no-answer',
      CallDuration: '0',
    } as any);
    await new Promise((r) => setImmediate(r));
    const [, eventType] = outboundWebhooksService.emitEvent.mock.calls[0];
    expect(eventType).toBe(WebhookEventType.CALL_MISSED);
  });

  it('emits CALL_MISSED on status=busy', async () => {
    const { svc, outboundWebhooksService } = buildSvc();
    await svc.handleCallStatus({
      CallSid: CALL_SID,
      CallStatus: 'busy',
      CallDuration: '0',
    } as any);
    await new Promise((r) => setImmediate(r));
    const [, eventType] = outboundWebhooksService.emitEvent.mock.calls[0];
    expect(eventType).toBe(WebhookEventType.CALL_MISSED);
  });

  it('emits CALL_MISSED on status=failed', async () => {
    const { svc, outboundWebhooksService } = buildSvc();
    await svc.handleCallStatus({
      CallSid: CALL_SID,
      CallStatus: 'failed',
      CallDuration: '0',
    } as any);
    await new Promise((r) => setImmediate(r));
    const [, eventType] = outboundWebhooksService.emitEvent.mock.calls[0];
    expect(eventType).toBe(WebhookEventType.CALL_MISSED);
  });

  it('falls back to conversation.tenantId when TPN has no tenant', async () => {
    const { svc, outboundWebhooksService } = buildSvc({
      tpnTenantId: null,
      conversationTenantId: 'conv-tenant-fallback',
    });
    await svc.handleCallStatus({
      CallSid: CALL_SID,
      CallStatus: 'completed',
      CallDuration: '5',
    } as any);
    await new Promise((r) => setImmediate(r));
    const [, , , scope] = outboundWebhooksService.emitEvent.mock.calls[0];
    expect(scope.tenantId).toBe('conv-tenant-fallback');
  });

  it('passes tenantId=undefined when neither TPN nor conversation carry one — still emits', async () => {
    // Legacy path: workspace-scoped subscriptions still fire; tenant-scoped
    // subs correctly do NOT match (fan-out invariant preserved).
    const { svc, outboundWebhooksService } = buildSvc({
      tpnTenantId: null,
      conversationTenantId: null,
    });
    await svc.handleCallStatus({
      CallSid: CALL_SID,
      CallStatus: 'completed',
      CallDuration: '5',
    } as any);
    await new Promise((r) => setImmediate(r));
    expect(outboundWebhooksService.emitEvent).toHaveBeenCalledTimes(1);
    const [, , , scope] = outboundWebhooksService.emitEvent.mock.calls[0];
    expect(scope.tenantId).toBeUndefined();
  });

  it('passes businessId + profileId through when conversation carries them', async () => {
    const { svc, outboundWebhooksService } = buildSvc({
      businessId: 'biz-1',
      profileId: 'prof-1',
    });
    await svc.handleCallStatus({
      CallSid: CALL_SID,
      CallStatus: 'completed',
      CallDuration: '5',
    } as any);
    await new Promise((r) => setImmediate(r));
    const [, , , scope] = outboundWebhooksService.emitEvent.mock.calls[0];
    expect(scope.businessId).toBe('biz-1');
    expect(scope.profileId).toBe('prof-1');
    expect(scope.tenantId).toBe(TENANT_ID);
  });

  it('does not emit when the conversation cannot be loaded', async () => {
    const { svc, outboundWebhooksService } = buildSvc({
      conversationExists: false,
    });
    await svc.handleCallStatus({
      CallSid: CALL_SID,
      CallStatus: 'completed',
      CallDuration: '5',
    } as any);
    await new Promise((r) => setImmediate(r));
    expect(outboundWebhooksService.emitEvent).not.toHaveBeenCalled();
  });

  it('does not throw when outboundWebhooksService is not wired', async () => {
    const { svc } = buildSvc({ outboundWired: false });
    await expect(
      svc.handleCallStatus({
        CallSid: CALL_SID,
        CallStatus: 'completed',
        CallDuration: '5',
      } as any),
    ).resolves.toBeUndefined();
  });

  it('swallows emit errors — status-callback response is not blocked', async () => {
    const { svc, outboundWebhooksService } = buildSvc();
    outboundWebhooksService.emitEvent.mockRejectedValueOnce(
      new Error('subscription target 5xx'),
    );
    await expect(
      svc.handleCallStatus({
        CallSid: CALL_SID,
        CallStatus: 'completed',
        CallDuration: '5',
      } as any),
    ).resolves.toBeUndefined();
  });

  it('swallows scope-derivation errors — status-callback response is not blocked', async () => {
    const { svc, conversationRepo, outboundWebhooksService } = buildSvc();
    conversationRepo.findOne.mockRejectedValueOnce(
      new Error('db unavailable'),
    );
    await expect(
      svc.handleCallStatus({
        CallSid: CALL_SID,
        CallStatus: 'completed',
        CallDuration: '5',
      } as any),
    ).resolves.toBeUndefined();
    expect(outboundWebhooksService.emitEvent).not.toHaveBeenCalled();
  });
});
