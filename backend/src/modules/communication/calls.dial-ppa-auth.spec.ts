/**
 * P0-3 (2026-08-15) — cross-tenant caller-ID authorization on
 * `/v1/calls/dial` via profile_phone_assignments (PPA), matching the
 * SMS shared-assignment amendment in communication.service.ts:820-873.
 *
 * Same-tenant callers still pass without any PPA lookup. Cross-tenant
 * callers pass ONLY when an active PPA links the TPN to an active
 * profile under the caller's tenant. Cross-tenant without PPA
 * (or with an inactive one) denies with 403.
 */
import { ForbiddenException } from '@nestjs/common';
import { CallsV1Controller } from './calls.controller';
import type { DialCallDto } from './dto/call-ops.dto';

const WS = 'ws-1';
const OWNER_TENANT = 'tenant-owner';
const CALLER_TENANT = 'tenant-caller';
const INT_ID = 'a537cc3a-5c62-4f11-aff8-50fa840ef7a2';
const FROM = '+19045778584';
const TO = '+12483462681';

function makeCtrl(opts: {
  tpnOwnerTenant?: string;
  ppaResult?: any; // getRawOne return value
}) {
  const dialOutbound = jest.fn(async () => ({
    providerCallSid: 'CA_new_dial',
    status: 'queued',
    fromNumber: FROM,
    toNumber: TO,
    createdAt: new Date().toISOString(),
    integrationId: INT_ID,
  }));
  const twilioVoiceService: any = { dialOutbound };
  const forwarder: any = { isArmed: () => false, mintToken: () => 'tok', eventTypeForKind: () => 'voice_call_status' };
  const cfg: any = { get: (k: string) => (k === 'PUBLIC_BASE_URL' ? 'https://sigcore.test' : k === 'NODE_ENV' ? 'test' : undefined) };
  const idem: any = { claim: jest.fn(() => ({ status: 'new' })), remember: jest.fn(), release: jest.fn() };
  const guardSvc: any = {
    assert: jest.fn(async () => ({
      workspaceId: WS,
      tenantId: CALLER_TENANT,
      integration: { id: INT_ID, provider: 'twilio' },
    })),
  };
  const tpnRepo: any = {
    findOne: jest.fn(async () => ({
      id: 'tpn-1',
      workspaceId: WS,
      tenantId: opts.tpnOwnerTenant ?? CALLER_TENANT,
      phoneNumber: FROM,
      provider: 'twilio',
      channel: 'sms',
      metadata: { activeChannels: ['sms', 'voice'] },
    })),
  };
  const callRepo: any = {
    findOne: jest.fn(async () => null),
    create: jest.fn((x: any) => ({ ...x })),
    save: jest.fn(async (row: any) => row),
  };
  const conversationRepo: any = {
    findOne: jest.fn(async () => null),
    create: jest.fn((x: any) => ({ id: 'conv', ...x })),
    save: jest.fn(async (row: any) => ({ id: row.id ?? 'conv', ...row })),
  };
  const getRawOne = jest.fn(async () => opts.ppaResult ?? null);
  const qb: any = {
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getRawOne,
  };
  const ppaRepo: any = { createQueryBuilder: jest.fn(() => qb) };
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
  return { ctrl, dialOutbound, ppaRepo, getRawOne, qb };
}

function baseDto(): DialCallDto {
  return {
    integrationId: INT_ID,
    tenantId: CALLER_TENANT,
    fromNumber: FROM,
    toNumber: TO,
    answerMode: 'hangup',
  } as DialCallDto;
}
function baseReq() {
  return { workspaceId: WS, tenantId: CALLER_TENANT, authType: 'api_key', authScopeType: 'tenant' } as any;
}

describe('CallsV1Controller.dial — P0-3 PPA caller-ID authorization', () => {
  it('same-tenant TPN passes without any PPA lookup', async () => {
    const { ctrl, dialOutbound, ppaRepo } = makeCtrl({ tpnOwnerTenant: CALLER_TENANT });
    const res = await ctrl.dial(baseDto(), 'idem-key-a', baseReq());
    expect((res.data as any).providerCallSid).toBe('CA_new_dial');
    expect(dialOutbound).toHaveBeenCalled();
    // No PPA lookup performed on the same-tenant fast path.
    expect(ppaRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it('cross-tenant TPN passes when an active PPA links TPN → active profile under caller tenant', async () => {
    const { ctrl, dialOutbound, ppaRepo, qb } = makeCtrl({
      tpnOwnerTenant: OWNER_TENANT,
      ppaResult: { ppa_id: 'ppa-1' },
    });
    const res = await ctrl.dial(baseDto(), 'idem-key-b', baseReq());
    expect((res.data as any).providerCallSid).toBe('CA_new_dial');
    expect(dialOutbound).toHaveBeenCalled();
    // PPA query ran, and it enforced the four required predicates.
    expect(ppaRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    const andWhereCalls = (qb.andWhere as jest.Mock).mock.calls.map((c: any[]) => c[0]);
    expect(andWhereCalls).toEqual(
      expect.arrayContaining([
        'ppa.active = TRUE',
        'p.workspace_id = :workspaceId',
        'p.tenant_id = :callerTenant',
        "p.status = 'active'",
      ]),
    );
  });

  it('cross-tenant TPN with no PPA denies with 403 and does NOT dial', async () => {
    const { ctrl, dialOutbound } = makeCtrl({
      tpnOwnerTenant: OWNER_TENANT,
      ppaResult: null,
    });
    await expect(ctrl.dial(baseDto(), 'idem-key-c', baseReq())).rejects.toBeInstanceOf(ForbiddenException);
    expect(dialOutbound).not.toHaveBeenCalled();
  });

  it('cross-tenant TPN with inactive PPA denies with 403 (PPA query returns null because ppa.active=TRUE predicate fails)', async () => {
    // Semantically identical to the no-PPA case: the WHERE clause on
    // `ppa.active = TRUE` excludes inactive rows so getRawOne returns
    // null. This test pins that our filter, not application logic,
    // is what enforces the active-only rule.
    const { ctrl, dialOutbound } = makeCtrl({
      tpnOwnerTenant: OWNER_TENANT,
      ppaResult: null,
    });
    await expect(ctrl.dial(baseDto(), 'idem-key-d', baseReq())).rejects.toBeInstanceOf(ForbiddenException);
    expect(dialOutbound).not.toHaveBeenCalled();
  });

  it('TPN not found in the workspace at all denies with 403 (cross-workspace impossible by construction)', async () => {
    const dialOutbound = jest.fn();
    const twilioVoiceService: any = { dialOutbound };
    const forwarder: any = { isArmed: () => false, mintToken: () => 'tok', eventTypeForKind: () => 'voice_call_status' };
    const cfg: any = { get: (k: string) => (k === 'NODE_ENV' ? 'test' : undefined) };
    const idem: any = { claim: jest.fn(() => ({ status: 'new' })) };
    const guardSvc: any = {
      assert: jest.fn(async () => ({
        workspaceId: WS,
        tenantId: CALLER_TENANT,
        integration: { id: INT_ID, provider: 'twilio' },
      })),
    };
    const tpnRepo: any = { findOne: jest.fn(async () => null) }; // TPN missing
    const callRepo: any = { findOne: jest.fn(), create: jest.fn(), save: jest.fn() };
    const conversationRepo: any = { findOne: jest.fn(), create: jest.fn(), save: jest.fn() };
    const ppaRepo: any = { createQueryBuilder: jest.fn() };
    const profileRepo: any = {};
    const ctrl = new CallsV1Controller(
      twilioVoiceService, forwarder, cfg, idem, guardSvc,
      tpnRepo, callRepo, conversationRepo, ppaRepo, profileRepo,
    );
    await expect(ctrl.dial(baseDto(), 'idem-key-e', baseReq())).rejects.toBeInstanceOf(ForbiddenException);
    expect(dialOutbound).not.toHaveBeenCalled();
    // Not even a PPA lookup — we bailed out before that.
    expect(ppaRepo.createQueryBuilder).not.toHaveBeenCalled();
  });
});
