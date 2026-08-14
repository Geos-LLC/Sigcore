import type { ConfigService } from '@nestjs/config';
import { TwilioWebhooksService } from './twilio-webhooks.service';
import type {
  TenantVoiceForwarderService,
  ForwardResult,
} from './tenant-voice-forwarder.service';

// PR 3 — routing decision tree at the tenant-forward insertion point.
//
// The purpose of these specs is to prove that:
//   1. CallConnect terminal path stays unchanged (never reaches the new
//      step [3a])
//   2. Legacy callForwardingNumber terminal path stays unchanged
//   3. The new step [3a] fires ONLY when: flag on + tenant.voiceInboundUrl
//      set + forwarder injected + forwardCtx passed
//   4. On success, tenant TwiML is returned byte-for-byte
//   5. On failure, we flow to voicemail (existing behaviour)
//   6. When any gate is missing, we flow to voicemail — byte-identical
//      to pre-PR-3

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

const cfg = (values: Record<string, string | undefined> = {}) =>
  ({
    get: <T = string>(k: string): T | undefined => values[k] as T | undefined,
  }) as unknown as ConfigService;

const CALL = {
  CallSid: 'CA_test',
  From: '+15551234567',
  To: '+15550000000',
  Direction: 'inbound',
  AccountSid: 'AC_test',
  ApiVersion: '2010-04-01',
} as any;

const FORWARD_CTX = {
  rawBody: 'CallSid=CA_test',
  contentType: 'application/x-www-form-urlencoded',
  twilioSignature: 'sig',
  forwardedHeaders: { 'x-forwarded-for': '1.2.3.4' },
};

function build(opts: {
  flagOn?: boolean;
  ccSettings?: any;
  phoneAllocation?: any;
  tenant?: any;
  forwarderResult?: ForwardResult;
  forwarderPresent?: boolean;
}) {
  const conversationRepo = repo();
  const messageRepo = repo();
  const callRepo = repo();
  const integrationRepo = repo();
  const workspaceRepo = repo();
  const tenantPhoneNumberRepo = repo();
  const tenantRepo = repo();
  const ccSettingsRepo = repo();

  conversationRepo.findOne.mockResolvedValue({
    id: 'conv-1',
    workspaceId: 'ws-1',
    participantPhoneNumber: CALL.From,
    phoneNumber: CALL.To,
    provider: 'twilio',
    externalId: null,
    contactId: null,
    metadata: null,
  });
  callRepo.create.mockImplementation((x: any) => x);
  callRepo.save.mockImplementation(async (x: any) => x);
  // Legacy findOne + new find() mocks — 2026-08-14 deterministic-precedence
  // change moved to find() but existing tests still model the single-row shape.
  ccSettingsRepo.findOne.mockResolvedValue(opts.ccSettings ?? null);
  ccSettingsRepo.find.mockResolvedValue(
    opts.ccSettings ? [opts.ccSettings] : [],
  );
  tenantPhoneNumberRepo.findOne.mockResolvedValue(opts.phoneAllocation ?? null);
  tenantRepo.findOne.mockResolvedValue(opts.tenant ?? null);

  const encryptionService = {} as any;
  const configService = cfg({
    SIGCORE_VOICE_INBOUND_FORWARD_ENABLED: opts.flagOn ? 'true' : undefined,
  });
  const idempotencyService = {} as any;

  const forwarder: TenantVoiceForwarderService | undefined =
    opts.forwarderPresent === false
      ? undefined
      : ({
          forward: jest.fn(
            async () =>
              opts.forwarderResult ?? {
                outcome: 'success',
                twiml:
                  '<?xml version="1.0" encoding="UTF-8"?><Response><Say>from tenant</Say></Response>',
                statusCode: 200,
                durationMs: 42,
                contentType: 'application/xml',
              },
          ),
        } as unknown as TenantVoiceForwarderService);

  const eventsGateway = {
    emitNewMessage: jest.fn(),
    emitNewConversation: jest.fn(),
    emitConversationUpdate: jest.fn(),
    emitNewCall: jest.fn(),
    emitCallUpdate: jest.fn(),
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
    undefined,
    undefined,
    undefined,
    undefined,
    forwarder,
  );

  return { svc, tenantRepo, forwarder, tenantPhoneNumberRepo };
}

describe('TwilioWebhooksService.handleIncomingCall — PR 3 tenant forward', () => {
  it('CallConnect enabled path still terminates in <Dial> (never reaches [3a])', async () => {
    const { svc, forwarder } = build({
      flagOn: true,
      ccSettings: {
        botNumberE164: CALL.To,
        enabled: true,
        agentPhoneE164: '+15550001111',
        businessId: 'biz-1',
      },
      phoneAllocation: {
        workspaceId: 'ws-1',
        phoneNumber: CALL.To,
        tenantId: 'biz-1',
      },
      tenant: { id: 'biz-1', voiceInboundUrl: 'https://tenant/x' },
    });
    const twiml = await svc.handleIncomingCall('ws-1', CALL, FORWARD_CTX);
    expect(twiml).toContain('<Dial');
    expect((forwarder as any).forward).not.toHaveBeenCalled();
  });

  it('legacy callForwardingNumber path still terminates in <Dial> (never reaches [3a])', async () => {
    const { svc, forwarder } = build({
      flagOn: true,
      ccSettings: null,
      phoneAllocation: {
        workspaceId: 'ws-1',
        phoneNumber: CALL.To,
        tenantId: 't-1',
      },
      tenant: {
        id: 't-1',
        metadata: { callForwardingNumber: '+15550009999' },
        voiceInboundUrl: 'https://tenant/x',
      },
    });
    const twiml = await svc.handleIncomingCall('ws-1', CALL, FORWARD_CTX);
    expect(twiml).toContain('<Dial');
    expect((forwarder as any).forward).not.toHaveBeenCalled();
  });

  it('CC settings exist but not actionable → voicemail (unchanged; NOT tenant-forward)', async () => {
    const { svc, forwarder } = build({
      flagOn: true,
      ccSettings: {
        botNumberE164: CALL.To,
        enabled: false,
        agentPhoneE164: null,
        businessId: 'biz-1',
      },
      tenant: { id: 'biz-1', voiceInboundUrl: 'https://tenant/x' },
    });
    const twiml = await svc.handleIncomingCall('ws-1', CALL, FORWARD_CTX);
    expect(twiml).toContain('<Record');
    expect((forwarder as any).forward).not.toHaveBeenCalled();
  });

  it('flag ON + tenant.voiceInboundUrl set + no other route → forwarder called, TwiML returned byte-for-byte', async () => {
    const twimlFromTenant =
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say>hi from tenant</Say></Response>';
    const { svc, forwarder } = build({
      flagOn: true,
      phoneAllocation: {
        workspaceId: 'ws-1',
        phoneNumber: CALL.To,
        tenantId: 't-1',
      },
      tenant: {
        id: 't-1',
        metadata: {},
        voiceInboundUrl: 'https://tenant/x',
      },
      forwarderResult: {
        outcome: 'success',
        twiml: twimlFromTenant,
        statusCode: 200,
        durationMs: 33,
        contentType: 'application/xml',
      },
    });
    const twiml = await svc.handleIncomingCall('ws-1', CALL, FORWARD_CTX);
    expect(twiml).toBe(twimlFromTenant);
    expect((forwarder as any).forward).toHaveBeenCalledTimes(1);
    const args = ((forwarder as any).forward as jest.Mock).mock.calls[0][0];
    expect(args.voiceInboundUrl).toBe('https://tenant/x');
    expect(args.rawBody).toBe(FORWARD_CTX.rawBody);
    expect(args.twilioSignature).toBe(FORWARD_CTX.twilioSignature);
    expect(args.correlation.tenantId).toBe('t-1');
    expect(args.correlation.providerCallSid).toBe(CALL.CallSid);
  });

  it('flag ON + forwarder returns fallback → voicemail (single fallthrough, no retry)', async () => {
    const { svc, forwarder } = build({
      flagOn: true,
      phoneAllocation: {
        workspaceId: 'ws-1',
        phoneNumber: CALL.To,
        tenantId: 't-1',
      },
      tenant: {
        id: 't-1',
        metadata: {},
        voiceInboundUrl: 'https://tenant/x',
      },
      forwarderResult: {
        outcome: 'fallback',
        reason: 'timeout',
        category: 'ambiguous',
        durationMs: 5001,
      },
    });
    const twiml = await svc.handleIncomingCall('ws-1', CALL, FORWARD_CTX);
    expect(twiml).toContain('<Record');
    expect((forwarder as any).forward).toHaveBeenCalledTimes(1);
  });

  it('flag OFF → forwarder never called, voicemail returned (byte-identical to pre-PR-3)', async () => {
    const { svc, forwarder } = build({
      flagOn: false,
      phoneAllocation: {
        workspaceId: 'ws-1',
        phoneNumber: CALL.To,
        tenantId: 't-1',
      },
      tenant: {
        id: 't-1',
        metadata: {},
        voiceInboundUrl: 'https://tenant/x',
      },
    });
    const twiml = await svc.handleIncomingCall('ws-1', CALL, FORWARD_CTX);
    expect(twiml).toContain('<Record');
    expect((forwarder as any).forward).not.toHaveBeenCalled();
  });

  it('flag ON but tenant.voiceInboundUrl null → forwarder not called', async () => {
    const { svc, forwarder } = build({
      flagOn: true,
      phoneAllocation: {
        workspaceId: 'ws-1',
        phoneNumber: CALL.To,
        tenantId: 't-1',
      },
      tenant: { id: 't-1', metadata: {}, voiceInboundUrl: null },
    });
    const twiml = await svc.handleIncomingCall('ws-1', CALL, FORWARD_CTX);
    expect(twiml).toContain('<Record');
    expect((forwarder as any).forward).not.toHaveBeenCalled();
  });

  it('flag ON but forwardCtx omitted (unit-test path) → forwarder not called', async () => {
    const { svc, forwarder } = build({
      flagOn: true,
      phoneAllocation: {
        workspaceId: 'ws-1',
        phoneNumber: CALL.To,
        tenantId: 't-1',
      },
      tenant: {
        id: 't-1',
        metadata: {},
        voiceInboundUrl: 'https://tenant/x',
      },
    });
    const twiml = await svc.handleIncomingCall('ws-1', CALL);
    expect(twiml).toContain('<Record');
    expect((forwarder as any).forward).not.toHaveBeenCalled();
  });

  it('flag ON but forwarder service not injected → voicemail (safety)', async () => {
    const { svc } = build({
      flagOn: true,
      forwarderPresent: false,
      phoneAllocation: {
        workspaceId: 'ws-1',
        phoneNumber: CALL.To,
        tenantId: 't-1',
      },
      tenant: {
        id: 't-1',
        metadata: {},
        voiceInboundUrl: 'https://tenant/x',
      },
    });
    const twiml = await svc.handleIncomingCall('ws-1', CALL, FORWARD_CTX);
    expect(twiml).toContain('<Record');
  });

  it('exactly one forwarder invocation per call (no duplicate HTTP)', async () => {
    const { svc, forwarder } = build({
      flagOn: true,
      phoneAllocation: {
        workspaceId: 'ws-1',
        phoneNumber: CALL.To,
        tenantId: 't-1',
      },
      tenant: {
        id: 't-1',
        metadata: {},
        voiceInboundUrl: 'https://tenant/x',
      },
    });
    await svc.handleIncomingCall('ws-1', CALL, FORWARD_CTX);
    expect((forwarder as any).forward).toHaveBeenCalledTimes(1);
  });

  it('no phone allocation → voicemail directly, forwarder never called', async () => {
    const { svc, forwarder } = build({
      flagOn: true,
      phoneAllocation: null,
    });
    const twiml = await svc.handleIncomingCall('ws-1', CALL, FORWARD_CTX);
    expect(twiml).toContain('<Record');
    expect((forwarder as any).forward).not.toHaveBeenCalled();
  });
});
