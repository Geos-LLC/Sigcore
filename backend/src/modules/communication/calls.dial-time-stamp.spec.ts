/**
 * Wave-4 PR #1 (2026-08-14) — regression: `/v1/calls/dial` must stamp
 * `communication_calls.communication_integration_id` at dial time.
 *
 * Root cause of Wave-3 OUTBOUND post-call 502s: the call row was created
 * only when Twilio's status callback fired. Between dial-return and that
 * callback, `IntegrationResourceGuard` Check 4 (providerCallSid → integration
 * linkage) fell through to the AccountSid-prefix fallback, which mis-selected
 * a workspace-scoped integration for calls actually placed on a
 * tenant-scoped LB subaccount. Post-call recording/hangup then hit "Twilio
 * resource not found" on the wrong AccountSid.
 *
 * These tests pin: dial() persists the outbound row with the correct
 * integrationId BEFORE the request returns, and is idempotent when the
 * Twilio callback later touches the same row.
 */
import { CallsV1Controller } from './calls.controller';
import type { DialCallDto } from './dto/call-ops.dto';

const WS = 'ws-1';
const TENANT = 'tenant-1';
const INT_ID = 'a537cc3a-5c62-4f11-aff8-50fa840ef7a2'; // LB Twilio integration id
const FROM = '+19045778584';
const TO = '+12483462681';
const NEW_SID = 'CA_new_dial';

function makeCtrl(opts: {
  existingRow?: any;
  existingConversation?: any;
  saveThrows?: Error | null;
  dialResult?: { providerCallSid: string; status: string };
  tpnRow?: any;
  guardResult?: any;
}) {
  const dialOutbound = jest.fn(async () => opts.dialResult ?? {
    providerCallSid: NEW_SID,
    status: 'queued',
    fromNumber: FROM,
    toNumber: TO,
    createdAt: new Date().toISOString(),
    integrationId: INT_ID,
  });
  const twilioVoiceService: any = { dialOutbound };

  const forwarder: any = {
    isArmed: () => false,
    mintToken: () => 'tok_x',
    eventTypeForKind: () => 'voice_call_status',
  };
  const cfg: any = {
    get: (k: string) => {
      if (k === 'PUBLIC_BASE_URL') return 'https://sigcore.test';
      if (k === 'NODE_ENV') return 'test';
      return undefined;
    },
  };
  const idem: any = {
    claim: jest.fn(() => ({ status: 'new' })),
    remember: jest.fn(),
    release: jest.fn(),
  };
  const guardSvc: any = {
    assert: jest.fn(async () => opts.guardResult ?? {
      workspaceId: WS,
      tenantId: TENANT,
      integration: { id: INT_ID, provider: 'twilio' },
    }),
  };
  const tpnRepo: any = {
    findOne: jest.fn(async () => opts.tpnRow ?? {
      workspaceId: WS,
      tenantId: TENANT,
      phoneNumber: FROM,
      provider: 'twilio',
      channel: 'sms',
      metadata: { activeChannels: ['sms', 'voice'] },
    }),
  };

  let saveInvocations = 0;
  const callRepo: any = {
    findOne: jest.fn(async () => opts.existingRow ?? null),
    create: jest.fn((x: any) => ({ ...x })),
    save: jest.fn(async (row: any) => {
      saveInvocations++;
      if (opts.saveThrows && saveInvocations === 1) throw opts.saveThrows;
      return row;
    }),
  };
  const conversationRepo: any = {
    findOne: jest.fn(async () => opts.existingConversation ?? null),
    create: jest.fn((x: any) => ({ id: 'conv-new', ...x })),
    save: jest.fn(async (row: any) => ({ id: row.id ?? 'conv-new', ...row })),
  };
  // P0-3: PPA repos — permissive mocks; none of the stamp scenarios test
  // cross-tenant paths (see calls.dial-ppa-auth.spec.ts for that coverage).
  const ppaRepo: any = {
    createQueryBuilder: jest.fn(() => ({
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawOne: jest.fn(async () => ({ id: 'ppa-mock' })),
    })),
  };
  const profileRepo: any = {};

  const ctrl = new CallsV1Controller(
    twilioVoiceService,
    forwarder,
    cfg,
    idem,
    guardSvc,
    tpnRepo,
    callRepo,
    conversationRepo,
    ppaRepo,
    profileRepo,
  );
  return { ctrl, callRepo, conversationRepo, dialOutbound };
}

function baseDto(overrides: Partial<DialCallDto> = {}): DialCallDto {
  return {
    integrationId: INT_ID,
    tenantId: TENANT,
    fromNumber: FROM,
    toNumber: TO,
    answerMode: 'hangup',
    ...overrides,
  } as DialCallDto;
}
function baseReq() {
  return {
    workspaceId: WS,
    tenantId: TENANT,
    authType: 'api_key',
    authScopeType: 'tenant',
  } as any;
}

describe('CallsV1Controller.dial — Wave-4 PR #1 dial-time integrationId stamp', () => {
  it('creates communication_calls row with communication_integration_id at dial time (no existing row)', async () => {
    const { ctrl, callRepo, conversationRepo } = makeCtrl({});
    const res = await ctrl.dial(baseDto(), 'idem-key-1', baseReq());

    expect((res.data as any).providerCallSid).toBe(NEW_SID);
    // Conversation created
    expect(conversationRepo.save).toHaveBeenCalledTimes(1);
    // Call created
    expect(callRepo.save).toHaveBeenCalledTimes(1);
    const savedRow = (callRepo.save as jest.Mock).mock.calls[0][0];
    expect(savedRow.providerCallId).toBe(NEW_SID);
    expect(savedRow.communicationIntegrationId).toBe(INT_ID);
    expect(savedRow.direction).toBe('out');
    expect(savedRow.fromNumber).toBe(FROM);
    expect(savedRow.toNumber).toBe(TO);
    expect(savedRow.metadata.origin).toBe('sigcore_v1_dial');
    expect(savedRow.metadata.integrationId).toBe(INT_ID);
    expect(savedRow.metadata.answerMode).toBe('hangup');
  });

  it('reuses existing conversation when one already matches (workspace + externalId)', async () => {
    const existingConv = { id: 'conv-exists', workspaceId: WS, externalId: `${FROM}:${TO}` };
    const { ctrl, callRepo, conversationRepo } = makeCtrl({ existingConversation: existingConv });
    await ctrl.dial(baseDto(), 'idem-key-2', baseReq());

    expect(conversationRepo.save).not.toHaveBeenCalled(); // reused
    const savedRow = (callRepo.save as jest.Mock).mock.calls[0][0];
    expect(savedRow.conversationId).toBe('conv-exists');
    expect(savedRow.communicationIntegrationId).toBe(INT_ID);
  });

  it('back-stamps integrationId on a pre-existing row created by an earlier Twilio callback race', async () => {
    // Existing row from a status-callback race — no integrationId yet.
    const existingRow = {
      id: 'call-1',
      providerCallId: NEW_SID,
      communicationIntegrationId: null,
      metadata: { finalStatus: 'in-progress' },
    };
    const { ctrl, callRepo } = makeCtrl({ existingRow });
    await ctrl.dial(baseDto(), 'idem-key-3', baseReq());

    // Save called once for back-stamp, not twice (no duplicate insert)
    expect(callRepo.save).toHaveBeenCalledTimes(1);
    const backStamped = (callRepo.save as jest.Mock).mock.calls[0][0];
    expect(backStamped.id).toBe('call-1');
    expect(backStamped.communicationIntegrationId).toBe(INT_ID);
    expect(backStamped.metadata.integrationId).toBe(INT_ID);
    expect(backStamped.metadata.dialTimeStampBackfilled).toBe(true);
  });

  it('no-op back-stamp when existing row already has communicationIntegrationId', async () => {
    const existingRow = {
      id: 'call-2',
      providerCallId: NEW_SID,
      communicationIntegrationId: INT_ID, // already stamped
      metadata: {},
    };
    const { ctrl, callRepo } = makeCtrl({ existingRow });
    await ctrl.dial(baseDto(), 'idem-key-4', baseReq());
    expect(callRepo.save).not.toHaveBeenCalled();
  });

  it('best-effort: DB save failure does NOT fail the dial response (PSTN call is real)', async () => {
    const { ctrl } = makeCtrl({ saveThrows: new Error('unique_violation providerCallId') });
    const res = await ctrl.dial(baseDto(), 'idem-key-5', baseReq());
    // Response STILL returns with providerCallSid — the PSTN call is real.
    expect((res.data as any).providerCallSid).toBe(NEW_SID);
  });

  it('carries answerMode=media_stream into metadata (Wave-4 outbound-AI path)', async () => {
    const { ctrl, callRepo } = makeCtrl({});
    const dto = baseDto({
      answerMode: 'media_stream',
      mediaStreamWssBaseUrl: 'wss://callio.test/voice-stream',
      callioCallId: 'callio-call-1',
    });
    await ctrl.dial(dto, 'idem-key-6', baseReq());
    const savedRow = (callRepo.save as jest.Mock).mock.calls[0][0];
    expect(savedRow.metadata.answerMode).toBe('media_stream');
    expect(savedRow.communicationIntegrationId).toBe(INT_ID);
  });
});
