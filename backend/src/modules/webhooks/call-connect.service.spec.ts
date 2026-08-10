import { CallConnectService } from './call-connect.service';
import {
  CallConnectSettings,
  CallConnectMode,
  AgentStrategy,
  CallerIdStrategy,
  AgentVoicemailMode,
} from '../../database/entities/call-connect-settings.entity';
import {
  CallConnectSession,
  SessionStatus,
  CallConnectProvider,
} from '../../database/entities/call-connect-session.entity';

// ---------------------------------------------------------------------------
// Helpers: build mock repositories & services
// ---------------------------------------------------------------------------
function buildSettingsRepo() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((data: any) => ({ ...data } as CallConnectSettings)),
    save: jest.fn(async (entity: any) => entity),
    remove: jest.fn(),
  };
}

function buildMockRepo() {
  return { findOne: jest.fn(), find: jest.fn(), create: jest.fn(), save: jest.fn(), remove: jest.fn() };
}

function buildService(settingsRepo = buildSettingsRepo()) {
  const sessionRepo = buildMockRepo();
  const integrationRepo = buildMockRepo();
  const tenantIntegrationRepo = buildMockRepo();
  const tenantPhoneRepo = buildMockRepo();
  const encryptionService = { decrypt: jest.fn(), encrypt: jest.fn() };
  const outboundWebhooks = { emitEvent: jest.fn() };
  const config = { get: jest.fn().mockReturnValue('http://localhost:3002') };

  const service = new CallConnectService(
    settingsRepo as any,
    sessionRepo as any,
    integrationRepo as any,
    tenantIntegrationRepo as any,
    tenantPhoneRepo as any,
    encryptionService as any,
    outboundWebhooks as any,
    config as any,
  );

  return {
    service,
    settingsRepo,
    sessionRepo,
    tenantPhoneRepo,
    integrationRepo,
    tenantIntegrationRepo,
    encryptionService,
    config,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const WORKSPACE_ID = 'ws-1';
const ACCOUNT_ID = 'acct-1';
const BOT_NUMBER = '+19045778584';
const AGENT_PHONE = '+18139212100';

function makeSettings(overrides: Partial<CallConnectSettings> = {}): CallConnectSettings {
  return {
    businessId: ACCOUNT_ID,
    workspaceId: WORKSPACE_ID,
    enabled: true,
    mode: CallConnectMode.AGENT_FIRST,
    ringTimeoutSeconds: 60,
    agentAcceptDigits: '1',
    maxAgentAttempts: 2,
    agentStrategy: AgentStrategy.OWNER,
    leadRetryPolicy: null as any,
    quietHours: null as any,
    callerIdStrategy: CallerIdStrategy.BOT_NUMBER,
    botNumberE164: BOT_NUMBER,
    businessNumberE164: null as any,
    agentPhoneE164: AGENT_PHONE,
    agentWhisperMessage: null as any,
    leadGreetingMessage: null as any,
    leadVoicemailEnabled: false,
    leadVoicemailMessage: null as any,
    leadVoicemailRecordingUrl: null as any,
    agentVoicemailMode: AgentVoicemailMode.TTS,
    createdAt: new Date('2026-03-10'),
    updatedAt: new Date('2026-03-11'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('CallConnectService – upsertSettings', () => {
  it('creates new settings when none exist', async () => {
    const { service, settingsRepo, tenantPhoneRepo } = buildService();
    settingsRepo.findOne.mockResolvedValue(null);
    settingsRepo.find.mockResolvedValue([]);
    tenantPhoneRepo.findOne.mockResolvedValue({ phoneNumber: BOT_NUMBER });

    const result = await service.upsertSettings(WORKSPACE_ID, {
      businessId: ACCOUNT_ID,
      botNumberE164: BOT_NUMBER,
      agentPhoneE164: AGENT_PHONE,
      enabled: true,
    });

    expect(settingsRepo.save).toHaveBeenCalledTimes(1);
    expect(result.businessId).toBe(ACCOUNT_ID);
    expect(result.workspaceId).toBe(WORKSPACE_ID);
    expect(result.botNumberE164).toBe(BOT_NUMBER);
  });

  it('updates existing settings when found', async () => {
    const existing = makeSettings();
    const { service, settingsRepo, tenantPhoneRepo } = buildService();
    settingsRepo.findOne.mockResolvedValue(existing);
    settingsRepo.find.mockResolvedValue([existing]);
    tenantPhoneRepo.findOne.mockResolvedValue({ phoneNumber: BOT_NUMBER });

    await service.upsertSettings(WORKSPACE_ID, {
      businessId: ACCOUNT_ID,
      agentPhoneE164: '+15551234567',
    });

    expect(settingsRepo.save).toHaveBeenCalledTimes(1);
    expect(existing.agentPhoneE164).toBe('+15551234567');
  });

  it('falls back to workspaceId when businessId is not provided', async () => {
    const { service, settingsRepo } = buildService();
    settingsRepo.findOne.mockResolvedValue(null);
    settingsRepo.find.mockResolvedValue([]);

    const result = await service.upsertSettings(WORKSPACE_ID, {
      botNumberE164: BOT_NUMBER,
      enabled: true,
    });

    expect(result.businessId).toBe(WORKSPACE_ID);
  });

  // =========================================================================
  // Stale legacy cleanup
  // =========================================================================
  describe('stale legacy CC settings cleanup', () => {
    it('deletes legacy row with same botNumber when per-account isolation is active', async () => {
      const { service, settingsRepo, tenantPhoneRepo } = buildService();
      const newRow = makeSettings({ businessId: ACCOUNT_ID, workspaceId: WORKSPACE_ID });
      const legacyRow = makeSettings({
        businessId: WORKSPACE_ID,   // legacy: businessId = workspaceId
        workspaceId: WORKSPACE_ID,
        botNumberE164: BOT_NUMBER,
        agentPhoneE164: '+12483462681', // old agent phone
        updatedAt: new Date('2026-01-01'),
      });

      settingsRepo.findOne.mockResolvedValue(null);
      settingsRepo.save.mockResolvedValue(newRow);
      settingsRepo.find.mockResolvedValue([newRow, legacyRow]);
      tenantPhoneRepo.findOne.mockResolvedValue({ phoneNumber: BOT_NUMBER });

      await service.upsertSettings(WORKSPACE_ID, {
        businessId: ACCOUNT_ID,
        botNumberE164: BOT_NUMBER,
        agentPhoneE164: AGENT_PHONE,
        enabled: true,
      });

      // Legacy row should be removed
      expect(settingsRepo.remove).toHaveBeenCalledWith(legacyRow);
    });

    it('deletes legacy row with null workspaceId', async () => {
      const { service, settingsRepo, tenantPhoneRepo } = buildService();
      const newRow = makeSettings({ businessId: ACCOUNT_ID, workspaceId: WORKSPACE_ID });
      const legacyRow = makeSettings({
        businessId: 'old-tenant-id',
        workspaceId: null,  // legacy: workspaceId is null
        botNumberE164: BOT_NUMBER,
        agentPhoneE164: '+12483462681',
      });

      settingsRepo.findOne.mockResolvedValue(null);
      settingsRepo.save.mockResolvedValue(newRow);
      settingsRepo.find.mockResolvedValue([newRow, legacyRow]);
      tenantPhoneRepo.findOne.mockResolvedValue(null);

      await service.upsertSettings(WORKSPACE_ID, {
        businessId: ACCOUNT_ID,
        botNumberE164: BOT_NUMBER,
        agentPhoneE164: AGENT_PHONE,
      });

      expect(settingsRepo.remove).toHaveBeenCalledWith(legacyRow);
    });

    it('does NOT delete other per-account rows (non-legacy)', async () => {
      const { service, settingsRepo, tenantPhoneRepo } = buildService();
      const newRow = makeSettings({ businessId: ACCOUNT_ID, workspaceId: WORKSPACE_ID });
      const otherAccountRow = makeSettings({
        businessId: 'acct-2',        // different account
        workspaceId: WORKSPACE_ID,   // same workspace — not legacy
        botNumberE164: BOT_NUMBER,
        agentPhoneE164: '+15559999999',
      });

      settingsRepo.findOne.mockResolvedValue(null);
      settingsRepo.save.mockResolvedValue(newRow);
      settingsRepo.find.mockResolvedValue([newRow, otherAccountRow]);
      tenantPhoneRepo.findOne.mockResolvedValue(null);

      await service.upsertSettings(WORKSPACE_ID, {
        businessId: ACCOUNT_ID,
        botNumberE164: BOT_NUMBER,
        agentPhoneE164: AGENT_PHONE,
      });

      // Should NOT remove the other account's row
      expect(settingsRepo.remove).not.toHaveBeenCalled();
    });

    it('skips cleanup when businessId === workspaceId (legacy caller)', async () => {
      const { service, settingsRepo } = buildService();
      const row = makeSettings({ businessId: WORKSPACE_ID, workspaceId: WORKSPACE_ID });

      settingsRepo.findOne.mockResolvedValue(null);
      settingsRepo.save.mockResolvedValue(row);

      await service.upsertSettings(WORKSPACE_ID, {
        // No businessId → falls back to workspaceId
        botNumberE164: BOT_NUMBER,
        enabled: true,
      });

      // find() should NOT be called because businessId === workspaceId
      expect(settingsRepo.find).not.toHaveBeenCalled();
      expect(settingsRepo.remove).not.toHaveBeenCalled();
    });

    it('skips cleanup when botNumberE164 is not set', async () => {
      const { service, settingsRepo } = buildService();
      const row = makeSettings({ businessId: ACCOUNT_ID, workspaceId: WORKSPACE_ID, botNumberE164: null as any });

      settingsRepo.findOne.mockResolvedValue(null);
      settingsRepo.save.mockResolvedValue(row);

      await service.upsertSettings(WORKSPACE_ID, {
        businessId: ACCOUNT_ID,
        enabled: true,
      });

      expect(settingsRepo.find).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Agent TwiML rendering — Fix A: per-session whisper must override workspace
// settings, so cross-tenant sessions on a shared bot number render the same
// substituted whisper LB sent in /call-connect/start regardless of which
// tenant owns the settings row.
// ---------------------------------------------------------------------------
function makeSession(overrides: Partial<CallConnectSession> = {}): CallConnectSession {
  return {
    id: 'session-1',
    businessId: WORKSPACE_ID,
    tenantId: null as any,
    leadId: 'lead-1',
    leadPhoneE164: '+15551234567',
    leadSummary: 'Ed R. — Regular home cleaning — Jacksonville',
    agentId: null as any,
    agentPhoneE164: AGENT_PHONE,
    mode: CallConnectMode.AGENT_FIRST,
    status: SessionStatus.CREATED,
    provider: CallConnectProvider.TWILIO,
    fromNumberE164: BOT_NUMBER,
    agentCallSid: null as any,
    leadCallSid: null as any,
    conferenceName: 'cc_session-1',
    attempt: 1,
    failureReason: null as any,
    recordingUrl: null as any,
    agentWhisperMessage: null as any,
    leadGreetingMessage: null as any,
    leadVoicemailMessage: null as any,
    sigcoreConversationId: null as any,
    recordAgentLeg: false,
    skipAgentWhisper: false,
    timeline: [],
    transcript: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('CallConnectService – handleAgentTwiml whisper precedence', () => {
  it('uses session.agentWhisperMessage when present (per-session wins over settings)', async () => {
    const { service, settingsRepo, sessionRepo } = buildService();
    const perSessionWhisper =
      'You have a new lead for Regular home cleaning. Customer name: Ed R.. Press any key to connect.';
    sessionRepo.findOne.mockResolvedValue(makeSession({ agentWhisperMessage: perSessionWhisper }));
    settingsRepo.findOne.mockResolvedValue(
      makeSettings({ agentWhisperMessage: 'WORKSPACE TEMPLATE THAT SHOULD NOT BE USED' }),
    );

    const twiml = await service.handleAgentTwiml('session-1');

    expect(twiml).toContain(perSessionWhisper);
    expect(twiml).not.toContain('WORKSPACE TEMPLATE THAT SHOULD NOT BE USED');
    // Gather must wrap the whisper so DTMF pressed during playback is captured.
    expect(twiml).toMatch(/<Gather[^>]*>[\s\S]*Press any key to connect\.[\s\S]*<\/Gather>/);
  });

  it('falls back to settings.agentWhisperMessage when session field is null (no LB override)', async () => {
    const { service, settingsRepo, sessionRepo } = buildService();
    sessionRepo.findOne.mockResolvedValue(makeSession({ agentWhisperMessage: null as any }));
    settingsRepo.findOne.mockResolvedValue(
      makeSettings({ agentWhisperMessage: 'Workspace whisper for {customerName}.' }),
    );

    const twiml = await service.handleAgentTwiml('session-1');

    // {customerName} substituted from leadSummary "Ed R. — Regular home cleaning — Jacksonville"
    expect(twiml).toContain('Workspace whisper for Ed R..');
  });

  it('falls back to the built-in default when neither session nor settings have a whisper', async () => {
    const { service, settingsRepo, sessionRepo } = buildService();
    sessionRepo.findOne.mockResolvedValue(makeSession({ agentWhisperMessage: null as any }));
    settingsRepo.findOne.mockResolvedValue(makeSettings({ agentWhisperMessage: null as any }));

    const twiml = await service.handleAgentTwiml('session-1');

    // Default template: "New lead for {category}. Customer: {customerName}. Press {digit} to connect."
    expect(twiml).toContain('Regular home cleaning');
    expect(twiml).toContain('Ed R.');
    expect(twiml).toContain('to connect');
  });

  it('renders gather + hangup TwiML even when settings row is missing entirely (cross-tenant shared-phone path)', async () => {
    const { service, settingsRepo, sessionRepo } = buildService();
    const perSessionWhisper = 'Press any key to connect.';
    sessionRepo.findOne.mockResolvedValue(makeSession({ agentWhisperMessage: perSessionWhisper }));
    // Simulates the Yelp-JAX scenario: agent TwiML lookup keys by session.businessId
    // (= workspaceId), and that row may not exist when settings were configured per-account.
    settingsRepo.findOne.mockResolvedValue(null);

    const twiml = await service.handleAgentTwiml('session-1');

    expect(twiml).toContain(perSessionWhisper);
    // Default acceptDigits='0123456789' (length>3) → "any key"
    expect(twiml).toContain('Press any key to connect.');
    expect(twiml).toContain('<Hangup');
  });

  it('returns hangup TwiML when session is not found', async () => {
    const { service, sessionRepo } = buildService();
    sessionRepo.findOne.mockResolvedValue(null);

    const twiml = await service.handleAgentTwiml('missing-session');
    expect(twiml).toContain('<Hangup');
  });
});

// ---------------------------------------------------------------------------
// skipAgentWhisper — AI receptionist branch: bypass whisper + DTMF Gather and
// drop the agent leg directly into the conference. LB sets this when it's
// routing inbound leads to a Callio AI number that answers with speech.
// ---------------------------------------------------------------------------
describe('CallConnectService – handleAgentTwiml skipAgentWhisper branch', () => {
  it('skips Gather + whisper and drops agent straight into conference when session.skipAgentWhisper=true', async () => {
    const { service, settingsRepo, sessionRepo } = buildService();
    sessionRepo.findOne.mockResolvedValue(
      makeSession({
        skipAgentWhisper: true,
        agentWhisperMessage: 'IGNORED — should not appear in TwiML',
      }),
    );
    settingsRepo.findOne.mockResolvedValue(
      makeSettings({ agentWhisperMessage: 'ALSO IGNORED' }),
    );
    // initiateLeadCall is fire-and-forget and touches the Twilio client — stub it
    // out so the test doesn't leak an unhandled rejection.
    const initiateSpy = jest
      .spyOn(service as any, 'initiateLeadCall')
      .mockResolvedValue(undefined);

    const twiml = await service.handleAgentTwiml('session-1');

    expect(twiml).not.toContain('<Gather');
    expect(twiml).not.toContain('IGNORED');
    expect(twiml).not.toContain('to connect');
    expect(twiml).toMatch(/<Dial>[\s\S]*<Conference[^>]*>cc_session-1<\/Conference>[\s\S]*<\/Dial>/);
    expect(initiateSpy).toHaveBeenCalledTimes(1);
    // Session must be advanced to AGENT_ACCEPTED so downstream state machine
    // treats the AI-agent leg as an accepted agent.
    expect(sessionRepo.save).toHaveBeenCalled();
    const lastSave = sessionRepo.save.mock.calls[sessionRepo.save.mock.calls.length - 1][0];
    expect(lastSave.status).toBe(SessionStatus.AGENT_ACCEPTED);
  });

  it('keeps the whisper + Gather flow when skipAgentWhisper=false (default AGENT_FIRST path)', async () => {
    const { service, settingsRepo, sessionRepo } = buildService();
    sessionRepo.findOne.mockResolvedValue(
      makeSession({
        skipAgentWhisper: false,
        agentWhisperMessage: 'Human-agent whisper.',
      }),
    );
    settingsRepo.findOne.mockResolvedValue(makeSettings());

    const twiml = await service.handleAgentTwiml('session-1');

    expect(twiml).toContain('<Gather');
    expect(twiml).toContain('Human-agent whisper.');
  });
});

// ---------------------------------------------------------------------------
// Twilio account-selection telemetry (diagnostic-only, 2026-07-14 incident).
//
// These tests do not exercise `twilio.calls.create()` against a live client
// (that requires a real Twilio account SID/auth token). They exercise the
// internal resolution + logging + failure-capture helpers directly against
// a fake selection whose `client.calls.create` is a jest.fn() that throws
// on demand. Existing behaviour of `getTwilioClient` is verified by
// asserting the same DB reads happen and the returned client has the
// Twilio SDK's shape.
// ---------------------------------------------------------------------------
const AUTH_TOKEN_MASTER = 'auth-token-master-do-not-log-123';
const AUTH_TOKEN_TENANT = 'auth-token-tenant-do-not-log-456';
const AUTH_TOKEN_SUBACCT = 'auth-token-subacct-do-not-log-789';

const ACCOUNT_SID_MASTER = 'AC4d3fe3eb0000000000000000000000abcd';
const ACCOUNT_SID_TENANT = 'ACdddddddddddddddddddddddddddddd1234';
const ACCOUNT_SID_SUBACCT = 'ACfefefefefefefefefefefefefefefe9999';

describe('CallConnectService – Twilio account-selection telemetry', () => {
  function primeWorkspaceIntegration(
    integrationRepo: ReturnType<typeof buildMockRepo>,
    encryptionService: { decrypt: jest.Mock },
    opts: {
      accountSid?: string;
      authToken?: string;
      providerSubaccountSid?: string | null;
      integrationId?: string;
    } = {},
  ) {
    integrationRepo.findOne.mockResolvedValue({
      id: opts.integrationId ?? 'ws-integration-1',
      workspaceId: WORKSPACE_ID,
      provider: 'twilio',
      credentialsEncrypted: 'enc-blob-workspace',
      providerSubaccountSid: opts.providerSubaccountSid ?? null,
    });
    encryptionService.decrypt.mockImplementation((enc: string) => {
      if (enc === 'enc-blob-workspace') {
        return JSON.stringify({
          accountSid: opts.accountSid ?? ACCOUNT_SID_MASTER,
          authToken: opts.authToken ?? AUTH_TOKEN_MASTER,
        });
      }
      if (enc === 'enc-blob-tenant') {
        return JSON.stringify({
          accountSid: ACCOUNT_SID_TENANT,
          authToken: AUTH_TOKEN_TENANT,
        });
      }
      return '{}';
    });
  }

  function primeTenantIntegration(
    tenantIntegrationRepo: ReturnType<typeof buildMockRepo>,
  ) {
    tenantIntegrationRepo.findOne.mockResolvedValue({
      id: 'tenant-integration-1',
      workspaceId: WORKSPACE_ID,
      tenantId: 'tenant-1',
      provider: 'twilio',
      credentialsEncrypted: 'enc-blob-tenant',
    });
  }

  it('emits call_connect_twilio_client_selected with source=workspace when only the workspace integration exists', async () => {
    const {
      service,
      integrationRepo,
      tenantIntegrationRepo,
      tenantPhoneRepo,
      encryptionService,
    } = buildService();
    primeWorkspaceIntegration(integrationRepo, encryptionService, {
      accountSid: ACCOUNT_SID_MASTER,
      providerSubaccountSid: null,
      integrationId: 'ws-int-abc',
    });
    tenantIntegrationRepo.findOne.mockResolvedValue(null);
    tenantPhoneRepo.findOne.mockResolvedValue(null);
    const logSpy = jest.spyOn((service as any).logger, 'log');

    const session = makeSession({
      id: 'sess-ws-1',
      businessId: WORKSPACE_ID,
      tenantId: 'tenant-1' as any,
      fromNumberE164: '+19045778584',
    });
    const sel = await (service as any).selectTwilioClientForLeg(session, 'lead');

    const selectionLog = logSpy.mock.calls
      .map((args) => String(args[0]))
      .find((line) => line.startsWith('call_connect_twilio_client_selected'));
    expect(selectionLog).toBeDefined();
    expect(selectionLog).toContain('sessionId=sess-ws-1');
    expect(selectionLog).toContain(`workspaceId=${WORKSPACE_ID}`);
    expect(selectionLog).toContain('tenantId=tenant-1');
    expect(selectionLog).toContain('integrationId=ws-int-abc');
    expect(selectionLog).toContain('selectionSource=workspace');
    expect(selectionLog).toContain('providerAccountSid=AC4d3f…abcd');
    expect(selectionLog).toContain('providerSubaccountSid=none');
    expect(selectionLog).toContain('fromNumber=+1904***8584');
    expect(selectionLog).toContain('selectedPhoneIntegrationId=none');
    expect(selectionLog).toContain('leg=lead');
    expect(sel.selectionSource).toBe('workspace');
    expect(sel.providerAccountSid).toBe(ACCOUNT_SID_MASTER);
    expect(sel.selectedPhoneIntegrationId).toBeNull();
  });

  it('emits call_connect_twilio_client_selected with source=tenant when a tenant integration exists', async () => {
    const {
      service,
      integrationRepo,
      tenantIntegrationRepo,
      tenantPhoneRepo,
      encryptionService,
    } = buildService();
    primeWorkspaceIntegration(integrationRepo, encryptionService);
    primeTenantIntegration(tenantIntegrationRepo);
    tenantPhoneRepo.findOne.mockResolvedValue(null);
    const logSpy = jest.spyOn((service as any).logger, 'log');

    const session = makeSession({
      id: 'sess-tenant-1',
      businessId: WORKSPACE_ID,
      tenantId: 'tenant-1' as any,
    });
    const sel = await (service as any).selectTwilioClientForLeg(session, 'agent');

    const selectionLog = logSpy.mock.calls
      .map((args) => String(args[0]))
      .find((line) => line.startsWith('call_connect_twilio_client_selected'));
    expect(selectionLog).toContain('selectionSource=tenant');
    expect(selectionLog).toContain('integrationId=tenant-integration-1');
    expect(selectionLog).toContain('leg=agent');
    expect(sel.selectionSource).toBe('tenant');
    expect(sel.integrationId).toBe('tenant-integration-1');
    expect(sel.providerAccountSid).toBe(ACCOUNT_SID_TENANT);
    // Workspace repo should NOT have been consulted when tenant wins.
    expect(integrationRepo.findOne).not.toHaveBeenCalled();
  });

  it('surfaces providerSubaccountSid when set on the workspace integration', async () => {
    const {
      service,
      integrationRepo,
      tenantIntegrationRepo,
      tenantPhoneRepo,
      encryptionService,
    } = buildService();
    primeWorkspaceIntegration(integrationRepo, encryptionService, {
      accountSid: ACCOUNT_SID_SUBACCT,
      authToken: AUTH_TOKEN_SUBACCT,
      providerSubaccountSid: ACCOUNT_SID_SUBACCT,
    });
    tenantIntegrationRepo.findOne.mockResolvedValue(null);
    tenantPhoneRepo.findOne.mockResolvedValue(null);
    const logSpy = jest.spyOn((service as any).logger, 'log');

    const session = makeSession({ tenantId: undefined as any });
    await (service as any).selectTwilioClientForLeg(session, 'lead');

    const selectionLog = logSpy.mock.calls
      .map((args) => String(args[0]))
      .find((line) => line.startsWith('call_connect_twilio_client_selected'));
    expect(selectionLog).toContain(`providerSubaccountSid=ACfefe…9999`);
    expect(selectionLog).toContain(`providerAccountSid=ACfefe…9999`);
  });

  it('populates selectedPhoneIntegrationId from tenant_phone_numbers.metadata.integrationId when present', async () => {
    const {
      service,
      integrationRepo,
      tenantIntegrationRepo,
      tenantPhoneRepo,
      encryptionService,
    } = buildService();
    primeWorkspaceIntegration(integrationRepo, encryptionService, {
      integrationId: 'ws-int-selected',
    });
    tenantIntegrationRepo.findOne.mockResolvedValue(null);
    tenantPhoneRepo.findOne.mockResolvedValue({
      id: 'tpn-1',
      workspaceId: WORKSPACE_ID,
      phoneNumber: '+19045778584',
      metadata: { integrationId: 'ws-int-actual-owner' },
    });
    const logSpy = jest.spyOn((service as any).logger, 'log');

    const session = makeSession({
      tenantId: undefined as any,
      fromNumberE164: '+19045778584',
    });
    const sel = await (service as any).selectTwilioClientForLeg(session, 'lead');

    expect(sel.selectedPhoneIntegrationId).toBe('ws-int-actual-owner');
    expect(sel.integrationId).toBe('ws-int-selected');
    const selectionLog = logSpy.mock.calls
      .map((args) => String(args[0]))
      .find((line) => line.startsWith('call_connect_twilio_client_selected'));
    expect(selectionLog).toContain('integrationId=ws-int-selected');
    expect(selectionLog).toContain('selectedPhoneIntegrationId=ws-int-actual-owner');
  });

  it('emits selectedPhoneIntegrationId=none when TPN row is missing or metadata is absent', async () => {
    const {
      service,
      integrationRepo,
      tenantIntegrationRepo,
      tenantPhoneRepo,
      encryptionService,
    } = buildService();
    primeWorkspaceIntegration(integrationRepo, encryptionService);
    tenantIntegrationRepo.findOne.mockResolvedValue(null);
    // No TPN row at all — the common case today.
    tenantPhoneRepo.findOne.mockResolvedValue(null);
    const logSpy = jest.spyOn((service as any).logger, 'log');

    const session = makeSession({ tenantId: undefined as any });
    const sel = await (service as any).selectTwilioClientForLeg(session, 'lead');

    expect(sel.selectedPhoneIntegrationId).toBeNull();
    const selectionLog = logSpy.mock.calls
      .map((args) => String(args[0]))
      .find((line) => line.startsWith('call_connect_twilio_client_selected'));
    expect(selectionLog).toContain('selectedPhoneIntegrationId=none');
  });

  // Builds a completely fake TwilioLegSelection so tests can control what
  // `.calls.create` and `.incomingPhoneNumbers.list` return. Bypasses the
  // real Twilio SDK entirely (whose `.calls` is a getter and can't be
  // reassigned on a live client instance).
  function makeFakeSelection(overrides: Partial<{
    integrationId: string;
    selectionSource: 'tenant' | 'workspace';
    providerAccountSid: string;
    providerSubaccountSid: string | null;
    selectedPhoneIntegrationId: string | null;
    createError: any;
    createReturn: any;
    listReturn: any[];
    listError: any;
  }> = {}): {
    selection: any;
    createMock: jest.Mock;
    listMock: jest.Mock;
  } {
    const createMock = overrides.createError
      ? jest.fn().mockRejectedValue(overrides.createError)
      : jest.fn().mockResolvedValue(overrides.createReturn ?? { sid: 'CA_test' });
    const listMock = overrides.listError
      ? jest.fn().mockRejectedValue(overrides.listError)
      : jest.fn().mockResolvedValue(overrides.listReturn ?? []);
    const client = {
      calls: { create: createMock },
      incomingPhoneNumbers: { list: listMock },
    };
    return {
      selection: {
        client,
        integrationId: overrides.integrationId ?? 'ws-int-fake',
        selectionSource: overrides.selectionSource ?? 'workspace',
        providerAccountSid: overrides.providerAccountSid ?? ACCOUNT_SID_MASTER,
        providerSubaccountSid:
          'providerSubaccountSid' in overrides
            ? overrides.providerSubaccountSid ?? null
            : null,
        selectedPhoneIntegrationId:
          'selectedPhoneIntegrationId' in overrides
            ? overrides.selectedPhoneIntegrationId ?? null
            : null,
      },
      createMock,
      listMock,
    };
  }

  it('never logs the decrypted auth token or credentials JSON', async () => {
    const { service } = buildService();
    const logSpy = jest.spyOn((service as any).logger, 'log');
    const warnSpy = jest.spyOn((service as any).logger, 'warn');

    const session = makeSession({ tenantId: undefined as any });
    const { selection } = makeFakeSelection({
      createError: Object.assign(new Error('boom'), { code: 21212 }),
    });

    // Emit the selection log manually so we exercise emitSelectionLog too.
    (service as any).emitSelectionLog(selection, session, 'lead');
    await expect(
      (service as any).createLegCall(selection, session, 'lead', {
        to: '+15551234567',
        from: session.fromNumberE164,
      }),
    ).rejects.toThrow('boom');

    const allLogs = [...logSpy.mock.calls, ...warnSpy.mock.calls]
      .map((args) => String(args[0]))
      .join('\n');
    expect(allLogs).not.toContain(AUTH_TOKEN_MASTER);
    expect(allLogs).not.toContain(AUTH_TOKEN_TENANT);
    expect(allLogs).not.toContain(AUTH_TOKEN_SUBACCT);
    expect(allLogs).not.toContain('authToken');
  });

  it('captures Twilio error code + message on client.calls.create failure and rethrows', async () => {
    const { service } = buildService();
    const warnSpy = jest.spyOn((service as any).logger, 'warn');

    const session = makeSession({
      id: 'sess-fail-1',
      businessId: WORKSPACE_ID,
      tenantId: 'tenant-1' as any,
      fromNumberE164: '+19045778584',
    });
    const { selection } = makeFakeSelection({
      integrationId: 'ws-int-fail',
      selectionSource: 'workspace',
      providerAccountSid: ACCOUNT_SID_MASTER,
      providerSubaccountSid: ACCOUNT_SID_SUBACCT,
      selectedPhoneIntegrationId: 'ws-int-actual-owner',
      createError: Object.assign(
        new Error('The From phone number is not a valid'),
        { code: 21212 },
      ),
    });

    await expect(
      (service as any).createLegCall(selection, session, 'lead', {
        to: '+15551234567',
        from: session.fromNumberE164,
      }),
    ).rejects.toThrow('The From phone number is not a valid');

    const failureLog = warnSpy.mock.calls
      .map((args) => String(args[0]))
      .find((line) => line.startsWith('call_connect_twilio_create_failed'));
    expect(failureLog).toBeDefined();
    expect(failureLog).toContain('sessionId=sess-fail-1');
    expect(failureLog).toContain('leg=lead');
    expect(failureLog).toContain(`workspaceId=${WORKSPACE_ID}`);
    expect(failureLog).toContain('tenantId=tenant-1');
    expect(failureLog).toContain('integrationId=ws-int-fail');
    expect(failureLog).toContain('selectionSource=workspace');
    expect(failureLog).toContain('providerAccountSid=AC4d3f…abcd');
    expect(failureLog).toContain(`providerSubaccountSid=ACfefe…9999`);
    expect(failureLog).toContain('fromNumber=+1904***8584');
    expect(failureLog).toContain('selectedPhoneIntegrationId=ws-int-actual-owner');
    expect(failureLog).toContain('toNumberMasked=+1555***4567');
    expect(failureLog).toContain('twilioErrorCode=21212');
    expect(failureLog).toContain('twilioErrorMessage=The From phone number is not a valid');
  });

  it('runs the ownership probe only when CALL_CONNECT_DIAG_OWNERSHIP=true', async () => {
    const { service, config } = buildService();
    config.get.mockImplementation((key: string) =>
      key === 'CALL_CONNECT_DIAG_OWNERSHIP' ? 'true' : 'http://localhost:3002',
    );
    const warnSpy = jest.spyOn((service as any).logger, 'warn');

    const session = makeSession({
      id: 'sess-own-1',
      tenantId: undefined as any,
      fromNumberE164: '+19045778584',
    });
    const { selection, listMock } = makeFakeSelection({
      createError: Object.assign(new Error('nope'), { code: 21212 }),
      listReturn: [],
    });

    await expect(
      (service as any).createLegCall(selection, session, 'lead', {
        to: '+15551234567',
        from: session.fromNumberE164,
      }),
    ).rejects.toThrow('nope');

    expect(listMock).toHaveBeenCalledWith({
      phoneNumber: '+19045778584',
      limit: 1,
    });
    const ownershipLog = warnSpy.mock.calls
      .map((args) => String(args[0]))
      .find((line) => line.startsWith('call_connect_twilio_ownership_check '));
    expect(ownershipLog).toContain('selectedAccountOwnsFromNumber=false');
    expect(ownershipLog).toContain('sessionId=sess-own-1');
  });

  it('does NOT run the ownership probe when the diag flag is unset', async () => {
    const { service, config } = buildService();
    config.get.mockImplementation((key: string) =>
      key === 'CALL_CONNECT_DIAG_OWNERSHIP' ? undefined : 'http://localhost:3002',
    );

    const session = makeSession({ tenantId: undefined as any });
    const { selection, listMock } = makeFakeSelection({
      createError: Object.assign(new Error('nope'), { code: 21212 }),
    });

    await expect(
      (service as any).createLegCall(selection, session, 'lead', {
        to: '+15551234567',
        from: session.fromNumberE164,
      }),
    ).rejects.toThrow('nope');

    expect(listMock).not.toHaveBeenCalled();
  });

  it('preserves existing getTwilioClient behavior (returns Twilio client, no telemetry)', async () => {
    const {
      service,
      integrationRepo,
      tenantIntegrationRepo,
      encryptionService,
    } = buildService();
    primeWorkspaceIntegration(integrationRepo, encryptionService);
    tenantIntegrationRepo.findOne.mockResolvedValue(null);
    const logSpy = jest.spyOn((service as any).logger, 'log');

    const client = await (service as any).getTwilioClient(WORKSPACE_ID);

    // Twilio SDK client exposes `.calls` and `.incomingPhoneNumbers`.
    expect(client).toBeDefined();
    expect(client.calls).toBeDefined();
    expect(client.incomingPhoneNumbers).toBeDefined();
    // getTwilioClient itself does not emit selection telemetry — that lives
    // at the leg-creation call sites so it stays "exactly once per leg".
    const anyTelemetry = logSpy.mock.calls
      .map((args) => String(args[0]))
      .some((line) => line.startsWith('call_connect_twilio_client_selected'));
    expect(anyTelemetry).toBe(false);
  });

  it('maskPhone keeps country + first-3 + last-4 and collapses short inputs', () => {
    const { service } = buildService();
    const mask = (service as any).maskPhone.bind(service);
    expect(mask('+19045778584')).toBe('+1904***8584');
    expect(mask('+447700900000')).toBe('+4477***0000');
    expect(mask('+12345')).toBe('***');
    expect(mask(undefined)).toBe('unknown');
    expect(mask(null)).toBe('unknown');
    expect(mask('')).toBe('unknown');
  });

  it('maskAccountSid keeps prefix + suffix and passes short values through', () => {
    const { service } = buildService();
    const mask = (service as any).maskAccountSid.bind(service);
    expect(mask('AC4d3fe3eb0000000000000000000000abcd')).toBe('AC4d3f…abcd');
    expect(mask('AC12345')).toBe('AC12345');
    expect(mask(null)).toBe('unknown');
    expect(mask(undefined)).toBe('unknown');
  });
});
