/**
 * Wave-2 Task 4 (PR-1) — provisionAndAssign forVoice extension.
 *
 * Runbook tests:
 *   - forVoice=false backward compatible
 *   - forVoice=true with custom URLs applies them to Twilio via provisioning
 *     helper (PR-1 correction: was previously only persisted to metadata)
 *   - metadata records provider-applied fields + any error surfaced
 *   - metadata-save failure is non-fatal
 */

import { PhoneAssignmentsService } from './phone-assignments.service';

function repo() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    save: jest.fn(async (x: any) => x),
    create: jest.fn((x: any) => x),
    createQueryBuilder: jest.fn(),
  };
}

function qb(one?: any, many: any[] = []) {
  const q: any = {
    where: jest.fn(() => q),
    andWhere: jest.fn(() => q),
    update: jest.fn(() => q),
    set: jest.fn(() => q),
    execute: jest.fn(async () => ({ affected: 0 })),
    getOne: jest.fn(async () => one ?? null),
    getMany: jest.fn(async () => many),
    getRawMany: jest.fn(async () => many),
  };
  return q;
}

const WS = 'ws-1';
const T = 'tenant-1';
const PROFILE = 'profile-1';
const TPN_ID = 'tpn-1';

function build(tpnOverrides: any = {}, provisioningOverrides: any = {}) {
  const profileRepo = repo();
  const tpnRepo = repo();
  const ppaRepo = repo();
  const ppaTxn = repo();
  ppaTxn.findOne.mockResolvedValue(null);
  ppaTxn.save.mockImplementation(async (x: any) => ({
    ...x,
    id: x.id ?? 'new-ppa',
  }));
  ppaTxn.create.mockImplementation((x: any) => x);
  ppaTxn.createQueryBuilder.mockImplementation(() => qb());

  const dataSource: any = {
    transaction: async (fn: any) => fn({ getRepository: () => ppaTxn }),
  };

  profileRepo.findOne.mockResolvedValue({
    id: PROFILE,
    workspaceId: WS,
    tenantId: T,
  });

  const tpn = {
    id: TPN_ID,
    workspaceId: WS,
    tenantId: T,
    phoneNumber: '+15550000000',
    providerId: 'PN_purchased',
    metadata: {},
    ...tpnOverrides,
  };
  tpnRepo.findOne.mockResolvedValue(tpn);

  const provisioning: any = {
    searchAvailableNumbers: jest.fn(async () => [
      { phoneNumber: '+15550000000' },
    ]),
    purchaseNumber: jest.fn(async () => ({ success: true, allocation: tpn })),
    applyPhoneNumberWebhookOverrides: jest.fn(async () => ({
      success: true,
      applied: [],
    })),
    ...provisioningOverrides,
  };

  const svc = new PhoneAssignmentsService(
    profileRepo as any,
    tpnRepo as any,
    ppaRepo as any,
    dataSource,
    provisioning,
  );

  return { svc, tpnRepo, provisioning, tpn };
}

describe('provisionAndAssign forVoice extension', () => {
  it('forVoice=false backward compatible — tpn.metadata untouched, no provider override call', async () => {
    const { svc, provisioning, tpn } = build();

    const result = await svc.provisionAndAssign(WS, {
      tenantId: T,
      profileId: PROFILE,
      areaCode: '555',
      capabilities: ['sms'],
      // no forVoice
    });

    expect(result.purchased).toBe(true);
    expect((tpn.metadata as any).voice).toBeUndefined();
    expect((tpn.metadata as any).voiceWebhooks).toBeUndefined();
    expect(provisioning.applyPhoneNumberWebhookOverrides).not.toHaveBeenCalled();
  });

  it('forVoice=true with custom URLs applies overrides to Twilio (PR-1 correction)', async () => {
    const { svc, provisioning, tpn } = build();

    const result = await svc.provisionAndAssign(WS, {
      tenantId: T,
      profileId: PROFILE,
      areaCode: '555',
      capabilities: ['voice'],
      forVoice: true,
      voiceUrl: 'https://x/voice',
      voiceFallbackUrl: 'https://x/vfb',
      statusCallbackUrl: 'https://x/status',
    });

    expect(result.purchased).toBe(true);
    // The three custom URLs were actually applied to Twilio via the
    // provisioning helper — not merely persisted to metadata.
    expect(
      provisioning.applyPhoneNumberWebhookOverrides,
    ).toHaveBeenCalledTimes(1);
    const [, sid, urls] = (
      provisioning.applyPhoneNumberWebhookOverrides as jest.Mock
    ).mock.calls[0];
    expect(sid).toBe('PN_purchased');
    expect(urls).toEqual({
      voiceUrl: 'https://x/voice',
      voiceFallbackUrl: 'https://x/vfb',
      statusCallbackUrl: 'https://x/status',
    });
    // Metadata reflects the applied intent + provider fields.
    expect((tpn.metadata as any).voice).toBe(true);
    expect((tpn.metadata as any).voiceWebhooks.voiceUrl).toBe('https://x/voice');
    expect((tpn.metadata as any).voiceWebhooks.voiceFallbackUrl).toBe('https://x/vfb');
    expect((tpn.metadata as any).voiceWebhooks.statusCallbackUrl).toBe(
      'https://x/status',
    );
  });

  it('forVoice=true with only voiceUrl still calls provider (partial override supported)', async () => {
    const { svc, provisioning } = build();

    await svc.provisionAndAssign(WS, {
      tenantId: T,
      profileId: PROFILE,
      forVoice: true,
      voiceUrl: 'https://only/voice',
    });

    expect(
      provisioning.applyPhoneNumberWebhookOverrides,
    ).toHaveBeenCalledTimes(1);
    const [, , urls] = (
      provisioning.applyPhoneNumberWebhookOverrides as jest.Mock
    ).mock.calls[0];
    expect(urls).toEqual({ voiceUrl: 'https://only/voice' });
  });

  it('forVoice=true with no custom URLs calls provider with empty overrides (no Twilio update side-effect)', async () => {
    const { svc, provisioning, tpn } = build();

    await svc.provisionAndAssign(WS, {
      tenantId: T,
      profileId: PROFILE,
      forVoice: true,
      // no url fields
    });

    // Provider helper is still invoked (defensive) but with empty overrides.
    // Its internal short-circuit returns {success:true, applied:[]} — no
    // Twilio round-trip.
    expect(
      provisioning.applyPhoneNumberWebhookOverrides,
    ).toHaveBeenCalledTimes(1);
    const [, , urls] = (
      provisioning.applyPhoneNumberWebhookOverrides as jest.Mock
    ).mock.calls[0];
    expect(urls).toEqual({});
    expect((tpn.metadata as any).voice).toBe(true);
    expect((tpn.metadata as any).voiceWebhooks.appliedToProvider).toEqual([]);
  });

  it('provider override failure is captured in metadata but does not abort provisioning', async () => {
    const { svc, tpn } = build(
      {},
      {
        applyPhoneNumberWebhookOverrides: jest.fn(async () => ({
          success: false,
          applied: [],
          error: 'twilio 500',
        })),
      },
    );

    const result = await svc.provisionAndAssign(WS, {
      tenantId: T,
      profileId: PROFILE,
      forVoice: true,
      voiceUrl: 'https://x',
    });

    expect(result.purchased).toBe(true);
    expect((tpn.metadata as any).voiceWebhooks.appliedToProvider).toEqual([]);
    expect((tpn.metadata as any).voiceWebhooks.providerError).toBe('twilio 500');
  });

  it('metadata-save failure is non-fatal (logged, not thrown)', async () => {
    const { svc, tpnRepo } = build();
    tpnRepo.save.mockRejectedValueOnce(new Error('transient db error'));

    await expect(
      svc.provisionAndAssign(WS, {
        tenantId: T,
        profileId: PROFILE,
        forVoice: true,
        voiceUrl: 'https://x',
      }),
    ).resolves.toBeDefined();
  });
});
