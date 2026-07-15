import type { ConfigService } from '@nestjs/config';
import { TwilioWebhooksService } from './twilio-webhooks.service';
import type { ProviderContextResolver } from '../integrations/provider-context-resolver.service';

// Sigcore Browser Voice Contract — Task 4.
//
// `handleOutgoingCall` is the TwiML App handler for browser-initiated calls
// (Voice SDK `Device.connect({ params: { To, From }})`). The browser is
// untrusted: any device holding a valid Voice SDK token could otherwise
// pass an arbitrary `From` and Twilio would happily dial with a spoofed
// caller ID.
//
// Enforcement is delegated to ProviderContextResolver (Incident 2026-07-14
// Phase 2 — the single source of truth for phone-number ownership). Rules:
//   - Resolver returns `by_number` → owned → allowed.
//   - Resolver returns any other rule (`by_legacy_workspace_fallback` etc.)
//     → number NOT in TPN allocation → rejected.
//   - Resolver throws → rejected.
//   - Env SIGCORE_VOICE_CALLER_ID_ENFORCEMENT=off → log-only rollback mode.
//
// Additional invariants:
//   - Allowed outbound calls are stamped with `metadata.origin = 'browser_sdk'`
//     and `communicationIntegrationId` (from resolver). This makes downstream
//     ownership resolution (Rule 2, `by_stamped_resource`) work without a
//     re-lookup, and enables PSTN/browser/AI attribution analytics.

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

const OUTBOUND_CALL = {
  CallSid: 'CA_out_1',
  From: '+17869050302',
  To: '+15551234567',
  Direction: 'outbound-api',
  AccountSid: 'AC_test',
  ApiVersion: '2010-04-01',
  CallStatus: 'in-progress',
  Caller: 'client:ws_ws-1_user_user-abc',
} as any;

type ResolveOutcome =
  | { rule: 'by_number'; integrationId: string }
  | { rule: 'by_legacy_workspace_fallback'; integrationId: string }
  | { throw: 'not-found' | 'forbidden' | 'conflict' };

function build(opts: {
  resolveOutcome?: ResolveOutcome | undefined;
  enforcement?: 'on' | 'off' | undefined;
  omitResolver?: boolean;
} = {}) {
  const conversationRepo = repo();
  const messageRepo = repo();
  const callRepo = repo();
  const integrationRepo = repo();
  const workspaceRepo = repo();
  const tenantPhoneNumberRepo = repo();
  const tenantRepo = repo();
  const ccSettingsRepo = repo();

  conversationRepo.findOne.mockResolvedValue(null); // triggers create
  conversationRepo.save.mockImplementation(async (x: any) => ({
    id: 'conv-out-1',
    ...x,
  }));
  callRepo.create.mockImplementation((x: any) => x);
  callRepo.save.mockImplementation(async (x: any) => x);

  const configService = cfg({
    SIGCORE_VOICE_CALLER_ID_ENFORCEMENT: opts.enforcement,
    BASE_URL: 'https://sigcore.test',
  });

  const eventsGateway = {
    emitNewCall: jest.fn(),
    emitNewMessage: jest.fn(),
    emitNewConversation: jest.fn(),
    emitConversationUpdate: jest.fn(),
    emitCallUpdate: jest.fn(),
  } as any;

  const providerContextResolver = opts.omitResolver
    ? undefined
    : ({
        resolve: jest.fn(async () => {
          const outcome = opts.resolveOutcome;
          if (!outcome) {
            const err = new Error('resolver called without outcome configured');
            throw err;
          }
          if ('throw' in outcome) {
            throw new Error(outcome.throw);
          }
          return {
            rule: outcome.rule,
            integration: { id: outcome.integrationId, provider: 'twilio' },
            workspaceId: 'ws-1',
            tenantId: null,
            provider: 'twilio',
            legacyFallback: outcome.rule === 'by_legacy_workspace_fallback',
          };
        }),
      } as unknown as ProviderContextResolver);

  const svc = new TwilioWebhooksService(
    conversationRepo as any,
    messageRepo as any,
    callRepo as any,
    integrationRepo as any,
    workspaceRepo as any,
    tenantPhoneNumberRepo as any,
    tenantRepo as any,
    ccSettingsRepo as any,
    {} as any,
    eventsGateway,
    configService,
    {} as any, // idempotencyService
    undefined, // tenantWebhooksService
    undefined, // outboundWebhooksService
    undefined, // callConnectService
    undefined, // inboundResolver
    undefined, // voiceForwarder
    providerContextResolver,
  );

  return { svc, providerContextResolver, callRepo };
}

describe('TwilioWebhooksService.handleOutgoingCall — caller-ID ownership via ProviderContextResolver', () => {
  it('resolver → by_number: emits <Dial callerId="From"> and stamps call with integrationId + origin=browser_sdk', async () => {
    const { svc, providerContextResolver, callRepo } = build({
      resolveOutcome: { rule: 'by_number', integrationId: 'int-42' },
    });

    const twiml = await svc.handleOutgoingCall('ws-1', OUTBOUND_CALL);

    expect((providerContextResolver as any).resolve).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      provider: 'twilio',
      fromNumber: '+17869050302',
    });
    expect(twiml).toContain('<Dial');
    expect(twiml).toContain('callerId="+17869050302"');
    expect(twiml).toContain('+15551234567');
    expect(twiml).not.toContain('<Hangup');

    // Stamp assertions — required by feedback item #3 (PSTN/browser/AI
    // attribution analytics). Missing either stamp breaks the analytics
    // contract; missing integrationId also breaks
    // ProviderContextResolver Rule 2 downstream.
    const saved = callRepo.save.mock.calls[0][0];
    expect(saved.communicationIntegrationId).toBe('int-42');
    expect(saved.metadata.origin).toBe('browser_sdk');
    expect(saved.metadata.callerIdentity).toBe('client:ws_ws-1_user_user-abc');
  });

  it('resolver → by_legacy_workspace_fallback: rejects with <Say>+<Hangup> (not_in_TPN)', async () => {
    // Legacy fallback = there IS an integration for the workspace, but the
    // From number wasn't looked up via TPN. In the caller-ID enforcement
    // world, that means the number isn't stamped as owned → reject.
    const { svc } = build({
      resolveOutcome: {
        rule: 'by_legacy_workspace_fallback',
        integrationId: 'int-99',
      },
    });

    const twiml = await svc.handleOutgoingCall('ws-1', OUTBOUND_CALL);

    expect(twiml).not.toContain('<Dial');
    expect(twiml).toContain('<Say');
    expect(twiml).toContain('<Hangup');
    expect(twiml).toContain('not authorized');
  });

  it('resolver throws (no integration / cross-workspace / conflict): rejects', async () => {
    const { svc } = build({ resolveOutcome: { throw: 'not-found' } });

    const twiml = await svc.handleOutgoingCall('ws-1', OUTBOUND_CALL);

    expect(twiml).not.toContain('<Dial');
    expect(twiml).toContain('<Hangup');
  });

  it('kill switch: SIGCORE_VOICE_CALLER_ID_ENFORCEMENT=off falls through to <Dial> even when resolver rejects', async () => {
    // Rollback mode: preserves pre-Task-4 behaviour so ops can flip the
    // enforcement off without a redeploy and compare traffic.
    const { svc } = build({
      resolveOutcome: { throw: 'not-found' },
      enforcement: 'off',
    });

    const twiml = await svc.handleOutgoingCall('ws-1', OUTBOUND_CALL);

    expect(twiml).toContain('<Dial');
    expect(twiml).toContain('callerId="+17869050302"');
    expect(twiml).not.toContain('not authorized');
  });

  it('resolver absent (partial DI): logs a skip warning but still dials — preserves existing unit tests', async () => {
    // The service is @Optional-decorated so existing unit specs that
    // construct TwilioWebhooksService directly (without wiring the resolver)
    // still work. Enforcement is skipped in that case — the primary
    // deployment always injects the resolver via the module.
    const { svc, callRepo } = build({ omitResolver: true });

    const twiml = await svc.handleOutgoingCall('ws-1', OUTBOUND_CALL);

    expect(twiml).toContain('<Dial');
    // No integrationId stamped when resolver is absent.
    const saved = callRepo.save.mock.calls[0][0];
    expect(saved.communicationIntegrationId).toBeUndefined();
    // But origin is still stamped — it doesn't depend on the resolver.
    expect(saved.metadata.origin).toBe('browser_sdk');
  });
});
