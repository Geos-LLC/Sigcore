/**
 * P0-2 (2026-08-15) — per-call opt-in async AMD on /v1/calls/dial.
 *
 * Pins:
 *   - `machineDetection: 'enabled'` in the DTO → controller passes
 *     `machineDetection: true` to `TwilioVoiceService.dialOutbound`.
 *   - Absent / 'disabled' → `machineDetection: false` (preserving the
 *     2026-08-12 revert; other callers see no behavior change).
 *   - Service adds Twilio's async-AMD params ONLY when both
 *     machineDetection is true AND a statusCallbackUrl is present
 *     (async AMD would have nowhere to POST the AnsweredBy without one).
 *   - `machineDetection: 'DetectMessageEnd'` — waits for the machine
 *     greeting to END + beep before firing, so we get
 *     `machine_end_beep` / `machine_end_silence` / `machine_end_other`
 *     rather than the false-positive-prone `machine_start`.
 */
import { CallsV1Controller } from './calls.controller';
import { TwilioVoiceService } from './twilio-voice.service';
import type { DialCallDto } from './dto/call-ops.dto';
import type { CommunicationIntegration } from '../../database/entities/communication-integration.entity';

const WS = 'ws-1';
const TENANT = 'tenant-1';
const INT_ID = 'integration-1';
const FROM = '+19045778584';
const TO = '+12483462681';

// -----------------------------------------------------------
// Controller-level wiring
// -----------------------------------------------------------

function makeCtrl(opts: { tpnOwnerTenant?: string } = {}) {
  const dialOutbound = jest.fn(async () => ({
    providerCallSid: 'CA_new',
    status: 'queued',
    fromNumber: FROM,
    toNumber: TO,
    createdAt: new Date().toISOString(),
    integrationId: INT_ID,
  }));
  const twilioVoiceService: any = { dialOutbound };
  const forwarder: any = {
    isArmed: () => true,
    mintToken: () => 'tok_signed',
    eventTypeForKind: () => 'voice_call_status',
  };
  const cfg: any = {
    get: (k: string) => (k === 'PUBLIC_BASE_URL' ? 'https://sigcore.test' : k === 'NODE_ENV' ? 'test' : undefined),
  };
  const idem: any = { claim: jest.fn(() => ({ status: 'new' })), remember: jest.fn(), release: jest.fn() };
  const guardSvc: any = {
    assert: jest.fn(async () => ({
      workspaceId: WS,
      tenantId: TENANT,
      integration: { id: INT_ID, provider: 'twilio' },
    })),
  };
  const tpnRepo: any = {
    findOne: jest.fn(async () => ({
      id: 'tpn-1',
      workspaceId: WS,
      tenantId: opts.tpnOwnerTenant ?? TENANT,
      phoneNumber: FROM,
      provider: 'twilio',
      channel: 'sms',
      metadata: { activeChannels: ['sms', 'voice'] },
    })),
  };
  const callRepo: any = {
    findOne: jest.fn(async () => null),
    create: jest.fn((x: any) => ({ ...x })),
    save: jest.fn(async (x: any) => x),
  };
  const conversationRepo: any = {
    findOne: jest.fn(async () => null),
    create: jest.fn((x: any) => ({ id: 'conv', ...x })),
    save: jest.fn(async (x: any) => ({ id: 'conv', ...x })),
  };
  const ppaRepo: any = {
    createQueryBuilder: jest.fn(() => ({
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawOne: jest.fn(async () => ({ id: 'ppa-ok' })),
    })),
  };
  const profileRepo: any = {};
  const ctrl = new CallsV1Controller(
    twilioVoiceService, forwarder, cfg, idem, guardSvc,
    tpnRepo, callRepo, conversationRepo, ppaRepo, profileRepo,
  );
  return { ctrl, dialOutbound };
}
function baseDto(overrides: Partial<DialCallDto> = {}): DialCallDto {
  return {
    integrationId: INT_ID,
    tenantId: TENANT,
    fromNumber: FROM,
    toNumber: TO,
    answerMode: 'hangup',
    statusCallbackUrl: 'https://callio.test/webhooks/status',
    ...overrides,
  } as DialCallDto;
}
function baseReq() {
  return { workspaceId: WS, tenantId: TENANT, authType: 'api_key', authScopeType: 'tenant' } as any;
}

describe('CallsV1Controller.dial — P0-2 opt-in AMD wiring', () => {
  it('DTO machineDetection="enabled" → dialOutbound called with machineDetection: true', async () => {
    const { ctrl, dialOutbound } = makeCtrl();
    await ctrl.dial(baseDto({ machineDetection: 'enabled' }), 'idem-amd-a', baseReq());
    const arg = (dialOutbound as jest.Mock).mock.calls[0][1];
    expect(arg.machineDetection).toBe(true);
  });

  it('DTO machineDetection absent → dialOutbound called with machineDetection: false (default off)', async () => {
    const { ctrl, dialOutbound } = makeCtrl();
    await ctrl.dial(baseDto(), 'idem-amd-b', baseReq());
    const arg = (dialOutbound as jest.Mock).mock.calls[0][1];
    expect(arg.machineDetection).toBe(false);
  });

  it('DTO machineDetection="disabled" → dialOutbound called with machineDetection: false', async () => {
    const { ctrl, dialOutbound } = makeCtrl();
    await ctrl.dial(baseDto({ machineDetection: 'disabled' }), 'idem-amd-c', baseReq());
    const arg = (dialOutbound as jest.Mock).mock.calls[0][1];
    expect(arg.machineDetection).toBe(false);
  });
});

// -----------------------------------------------------------
// Service-level Twilio param wiring
// -----------------------------------------------------------

describe('TwilioVoiceService.dialOutbound — P0-2 AMD Twilio params', () => {
  function makeSvcWithCapturedParams(): { svc: TwilioVoiceService; captured: any } {
    const svc = new TwilioVoiceService({ get: () => undefined } as any, {} as any);
    const captured: any = {};
    // Stub Twilio client to capture the params object without actually dialing.
    (svc as any).clientForIntegration = () => ({
      calls: {
        create: async (params: any) => {
          Object.assign(captured, { params });
          return { sid: 'CA_stub', status: 'queued', dateCreated: new Date().toISOString() };
        },
      },
    });
    return { svc, captured };
  }
  const fakeIntegration = {
    id: INT_ID,
    provider: 'twilio',
  } as unknown as CommunicationIntegration;

  it('machineDetection=true + statusCallbackUrl → adds all async AMD Twilio params', async () => {
    const { svc, captured } = makeSvcWithCapturedParams();
    await svc.dialOutbound(fakeIntegration, {
      fromNumber: FROM,
      toNumber: TO,
      answerUrl: 'https://sigcore.test/answer',
      statusCallbackUrl: 'https://sigcore.test/status/tok',
      machineDetection: true,
    });
    expect(captured.params.machineDetection).toBe('DetectMessageEnd');
    expect(captured.params.asyncAmd).toBe('true');
    expect(captured.params.asyncAmdStatusCallback).toBe('https://sigcore.test/status/tok');
    expect(captured.params.asyncAmdStatusCallbackMethod).toBe('POST');
    expect(captured.params.machineDetectionTimeout).toBe(15);
  });

  it('machineDetection=false → NO AMD params (existing behavior preserved)', async () => {
    const { svc, captured } = makeSvcWithCapturedParams();
    await svc.dialOutbound(fakeIntegration, {
      fromNumber: FROM,
      toNumber: TO,
      answerUrl: 'https://sigcore.test/answer',
      statusCallbackUrl: 'https://sigcore.test/status/tok',
      machineDetection: false,
    });
    expect(captured.params.machineDetection).toBeUndefined();
    expect(captured.params.asyncAmd).toBeUndefined();
    expect(captured.params.asyncAmdStatusCallback).toBeUndefined();
    expect(captured.params.machineDetectionTimeout).toBeUndefined();
  });

  it('machineDetection omitted → NO AMD params (default off — preserves 2026-08-12 revert)', async () => {
    const { svc, captured } = makeSvcWithCapturedParams();
    await svc.dialOutbound(fakeIntegration, {
      fromNumber: FROM,
      toNumber: TO,
      answerUrl: 'https://sigcore.test/answer',
      statusCallbackUrl: 'https://sigcore.test/status/tok',
    });
    expect(captured.params.machineDetection).toBeUndefined();
    expect(captured.params.asyncAmd).toBeUndefined();
  });

  it('machineDetection=true but NO statusCallbackUrl → NO AMD params (no place to POST result)', async () => {
    const { svc, captured } = makeSvcWithCapturedParams();
    await svc.dialOutbound(fakeIntegration, {
      fromNumber: FROM,
      toNumber: TO,
      answerUrl: 'https://sigcore.test/answer',
      machineDetection: true,
    });
    expect(captured.params.machineDetection).toBeUndefined();
    expect(captured.params.asyncAmd).toBeUndefined();
  });
});
