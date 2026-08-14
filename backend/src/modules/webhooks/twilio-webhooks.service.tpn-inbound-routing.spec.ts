import type { ConfigService } from '@nestjs/config';
import { TwilioWebhooksService } from './twilio-webhooks.service';

/**
 * Wave-2 2026-08-14 — deterministic per-TPN inbound routing precedence.
 *
 * Precedence tree these specs pin:
 *
 *   1. tpn.inbound_agent_phone_e164 (new column) → forward
 *   2. Exactly 1 actionable CC row → forward (single-tenant preserved)
 *   3. >1 actionable CC rows → fall through to tenant metadata
 *      (shared-bot; refuses to pick arbitrarily)
 *   4. 0 actionable CC + any CC row exists (disabled or missing-agent) → voicemail
 *      (preserves pre-existing BYO-protection contract)
 *   5. 0 CC rows at all → fall through to tenant metadata
 *   6. tenant.metadata.callForwardingNumber set → forward
 *   7. voicemail
 *
 * The old code used `findOne(where botNumber, order updated_at DESC)` which
 * silently picked arbitrarily when many SavedAccounts shared one bot.
 * Spotless had 33 CC rows on +19045778584; a diagnostic left behind on
 * 2026-07-14 pointed the "latest" row at a foreign phone. Discovered
 * during Wave 1 preflight audit on 2026-08-14.
 */

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

const cfg = () =>
  ({
    get: <T = string>(_k: string): T | undefined => undefined,
  }) as unknown as ConfigService;

const CALL = {
  CallSid: 'CA_tpn_routing',
  From: '+15551234567',
  To: '+19045778584',
  Direction: 'inbound',
  AccountSid: 'AC_test',
  ApiVersion: '2010-04-01',
} as any;

interface BuildOpts {
  phoneAllocation?: any;
  tenant?: any;
  ccRows?: any[];
}

function build(opts: BuildOpts) {
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

  // TPN lookup: the "workspace_id + phone_number" query returns the
  // allocation; the ownership-audit query ("+ tenant_id") returns
  // whatever the caller expects, default null.
  tenantPhoneNumberRepo.findOne.mockImplementation(async ({ where }: any) => {
    if (where.tenantId) {
      // Ownership audit lookup — return null so the warn log fires but the
      // path still forwards. Existing spec pattern.
      return null;
    }
    return opts.phoneAllocation ?? null;
  });
  tenantRepo.findOne.mockResolvedValue(opts.tenant ?? null);
  ccSettingsRepo.find.mockResolvedValue(opts.ccRows ?? []);

  const svc = new TwilioWebhooksService(
    conversationRepo as any,
    messageRepo as any,
    callRepo as any,
    integrationRepo as any,
    workspaceRepo as any,
    tenantPhoneNumberRepo as any,
    tenantRepo as any,
    ccSettingsRepo as any,
    {} as any, // encryption
    {
      emitNewMessage: jest.fn(),
      emitNewConversation: jest.fn(),
      emitConversationUpdate: jest.fn(),
      emitNewCall: jest.fn(),
      emitCallUpdate: jest.fn(),
    } as any,
    cfg(),
    {} as any, // idempotency
    undefined,
    undefined,
    undefined,
    undefined,
    undefined, // forwarder
  );
  return { svc, ccSettingsRepo };
}

describe('TwilioWebhooksService.handleIncomingCall — TPN-level inbound routing precedence', () => {
  it('step 1: tpn.inbound_agent_phone_e164 set → forward there, CC not consulted', async () => {
    const { svc, ccSettingsRepo } = build({
      phoneAllocation: {
        workspaceId: 'ws-1',
        phoneNumber: CALL.To,
        tenantId: 't-1',
        inboundAgentPhoneE164: '+19998887777',
      },
      // 5 actionable CC rows — should be IGNORED because TPN override wins
      ccRows: Array.from({ length: 5 }, (_, i) => ({
        businessId: `biz-${i}`,
        botNumberE164: CALL.To,
        enabled: true,
        agentPhoneE164: '+15550000000',
      })),
    });
    const twiml = await svc.handleIncomingCall('ws-1', CALL);
    expect(twiml).toContain('<Dial');
    expect(twiml).toContain('+19998887777');
    // The TPN override MUST short-circuit before CC lookup fires. If find
    // was called, precedence is broken.
    expect(ccSettingsRepo.find).not.toHaveBeenCalled();
  });

  it('step 2: exactly 1 actionable CC row → forwards to that agent (single-tenant preserved)', async () => {
    const { svc } = build({
      phoneAllocation: { workspaceId: 'ws-1', phoneNumber: CALL.To, tenantId: 't-1' },
      tenant: { id: 't-1', metadata: { callForwardingNumber: '+19999999999' } },
      ccRows: [
        { businessId: 'biz-1', botNumberE164: CALL.To, enabled: true, agentPhoneE164: '+15551110000' },
        { businessId: 'biz-2', botNumberE164: CALL.To, enabled: false, agentPhoneE164: '+15552220000' },
      ],
    });
    const twiml = await svc.handleIncomingCall('ws-1', CALL);
    expect(twiml).toContain('<Dial');
    expect(twiml).toContain('+15551110000');
    // Tenant metadata is NOT consulted — CC pick wins.
    expect(twiml).not.toContain('+19999999999');
  });

  it('step 3: multiple actionable CC rows → falls through to tenant.callForwardingNumber (shared-bot Spotless case)', async () => {
    // Spotless: 33 CC rows on +19045778584, 18 actionable pointing at
    // dispatcher +18139212100. Must NEVER pick one arbitrarily.
    const spotlessCcRows = [
      ...Array.from({ length: 18 }, (_, i) => ({
        businessId: `savedAcct-${i}`,
        botNumberE164: CALL.To,
        enabled: true,
        agentPhoneE164: '+18139212100',
      })),
      ...Array.from({ length: 15 }, (_, i) => ({
        businessId: `disabled-${i}`,
        botNumberE164: CALL.To,
        enabled: false,
        agentPhoneE164: '+18139212100',
      })),
    ];
    const { svc } = build({
      phoneAllocation: {
        workspaceId: 'ws-1',
        phoneNumber: CALL.To,
        tenantId: 'spotless-tenant',
        inboundAgentPhoneE164: null,
      },
      tenant: {
        id: 'spotless-tenant',
        metadata: { callForwardingNumber: '+18139212100' },
      },
      ccRows: spotlessCcRows,
    });
    const twiml = await svc.handleIncomingCall('ws-1', CALL);
    expect(twiml).toContain('<Dial');
    expect(twiml).toContain('+18139212100');
  });

  it('step 3b: multiple actionable CC rows with DIFFERENT agent phones → still falls through (no arbitrary pick)', async () => {
    // Even more damning shared-bot case: many actionable rows with
    // DIFFERENT agent numbers. We must not pick one — must fall through.
    const { svc } = build({
      phoneAllocation: { workspaceId: 'ws-1', phoneNumber: CALL.To, tenantId: 't-1' },
      tenant: { id: 't-1', metadata: { callForwardingNumber: '+18139212100' } },
      ccRows: [
        { businessId: 'a', botNumberE164: CALL.To, enabled: true, agentPhoneE164: '+15550001111' },
        { businessId: 'b', botNumberE164: CALL.To, enabled: true, agentPhoneE164: '+15550002222' },
        { businessId: 'c', botNumberE164: CALL.To, enabled: true, agentPhoneE164: '+15550003333' },
      ],
    });
    const twiml = await svc.handleIncomingCall('ws-1', CALL);
    expect(twiml).toContain('<Dial');
    expect(twiml).toContain('+18139212100');
    // None of the CC agent phones should appear.
    expect(twiml).not.toContain('+15550001111');
    expect(twiml).not.toContain('+15550002222');
    expect(twiml).not.toContain('+15550003333');
  });

  it('step 4: enabled CC row exists but agent null → voicemail (BYO-protection preserved)', async () => {
    // The 2 Spotless orphan rows (ea5d47e8, 200fc5f1) have enabled=true,
    // agent_phone=null. If they are the ONLY CC rows for a bot, we must
    // NOT fall through to tenant metadata — preserve pre-existing "CC
    // exists → don't fall through to BYO forwarding" contract.
    const { svc } = build({
      phoneAllocation: { workspaceId: 'ws-1', phoneNumber: CALL.To, tenantId: 't-1' },
      tenant: { id: 't-1', metadata: { callForwardingNumber: '+15550009999' } },
      ccRows: [
        { businessId: 'orphan-A', botNumberE164: CALL.To, enabled: true, agentPhoneE164: null },
        { businessId: 'orphan-B', botNumberE164: CALL.To, enabled: true, agentPhoneE164: null },
      ],
    });
    const twiml = await svc.handleIncomingCall('ws-1', CALL);
    expect(twiml).toContain('<Record');
    expect(twiml).not.toContain('+15550009999');
  });

  it('step 4b: disabled CC row exists (agent set) → voicemail (BYO-protection preserved)', async () => {
    const { svc } = build({
      phoneAllocation: { workspaceId: 'ws-1', phoneNumber: CALL.To, tenantId: 't-1' },
      tenant: { id: 't-1', metadata: { callForwardingNumber: '+15550009999' } },
      ccRows: [
        { businessId: 'biz-1', botNumberE164: CALL.To, enabled: false, agentPhoneE164: '+15551110000' },
      ],
    });
    const twiml = await svc.handleIncomingCall('ws-1', CALL);
    expect(twiml).toContain('<Record');
  });

  it('step 5+6: zero CC rows, tenant.callForwardingNumber set → forwards to tenant metadata', async () => {
    const { svc } = build({
      phoneAllocation: { workspaceId: 'ws-1', phoneNumber: CALL.To, tenantId: 't-1' },
      tenant: { id: 't-1', metadata: { callForwardingNumber: '+15550009999' } },
      ccRows: [],
    });
    const twiml = await svc.handleIncomingCall('ws-1', CALL);
    expect(twiml).toContain('<Dial');
    expect(twiml).toContain('+15550009999');
  });

  it('step 7: zero CC rows, no tenant metadata, no voice_inbound_url → voicemail', async () => {
    const { svc } = build({
      phoneAllocation: { workspaceId: 'ws-1', phoneNumber: CALL.To, tenantId: 't-1' },
      tenant: { id: 't-1', metadata: {} },
      ccRows: [],
    });
    const twiml = await svc.handleIncomingCall('ws-1', CALL);
    expect(twiml).toContain('<Record');
  });

  it('tpn.inbound_agent_phone override wins even when the CC pick is unambiguous', async () => {
    // Sanity: even if there is exactly ONE actionable CC row, the TPN
    // override MUST win. The override is the explicit ops signal.
    const { svc } = build({
      phoneAllocation: {
        workspaceId: 'ws-1',
        phoneNumber: CALL.To,
        tenantId: 't-1',
        inboundAgentPhoneE164: '+19998887777',
      },
      ccRows: [
        { businessId: 'biz-1', botNumberE164: CALL.To, enabled: true, agentPhoneE164: '+15550001111' },
      ],
    });
    const twiml = await svc.handleIncomingCall('ws-1', CALL);
    expect(twiml).toContain('+19998887777');
    expect(twiml).not.toContain('+15550001111');
  });
});
