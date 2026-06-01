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

  return { service, settingsRepo, sessionRepo, tenantPhoneRepo };
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
    timeline: [],
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
