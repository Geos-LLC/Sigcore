import { PhoneNumberProvisioningService } from './phone-number-provisioning.service';
import {
  PhoneNumberOrderStatus,
  PhoneNumberAllocationStatus,
} from '../../database/entities';
import { IntegrationStatus, ProviderType } from '../../database/entities/communication-integration.entity';

/**
 * Service-level wiring test: purchaseNumber must call ensureOutboundReady
 * after the TenantPhoneNumber is saved, must NOT roll back the Twilio
 * purchase when the chain materialization throws, and must materialize the
 * chain idempotently on a subsequent call so the operator can heal a
 * failed run by simply re-purchasing or calling the helper directly.
 *
 * Twilio is mocked end-to-end; we only assert the orchestration around
 * the new ensure-step.
 */

const WS = '1bcbb4e0-df1b-481c-83ba-0730df47a720';
const TENANT_ID = '7ae06bb6-90ee-475f-8346-289b11912e3f';

function makeRepoStub<T extends Record<string, any>>(seed: T[] = []) {
  const rows: any[] = [...seed];
  let n = 1;
  return {
    rows,
    findOne: jest.fn(async ({ where }: any) =>
      rows.find((r) => Object.entries(where).every(([k, v]) => r[k] === v)) ?? null,
    ),
    find: jest.fn(async ({ where }: any) =>
      rows.filter((r) => Object.entries(where ?? {}).every(([k, v]) => r[k] === v)),
    ),
    create: jest.fn((x: any) => ({ ...x })),
    save: jest.fn(async (entity: any) => {
      if (!entity.id) entity.id = `row-${n++}`;
      const idx = rows.findIndex((r) => r.id === entity.id);
      if (idx >= 0) rows[idx] = { ...rows[idx], ...entity };
      else rows.push(entity);
      return entity;
    }),
  };
}

function buildService(opts: { tenantSeed?: any[]; purchaseSucceeds?: boolean } = {}) {
  const orderRepo = makeRepoStub();
  const pricingRepo = {
    findOne: jest.fn(async () => null),
  };
  const tenantPhoneRepo = makeRepoStub();
  const integrationRepo = {
    findOne: jest.fn(async () => ({
      id: 'int-1',
      workspaceId: WS,
      provider: ProviderType.TWILIO,
      status: IntegrationStatus.ACTIVE,
      credentialsEncrypted: 'enc',
    })),
  };
  const tenantRepo = makeRepoStub(
    opts.tenantSeed ?? [
      {
        id: TENANT_ID,
        workspaceId: WS,
        name: 'Globus Service',
        externalId: 'globus-external-id',
      },
    ],
  );
  const workspaceRepo = { findOne: jest.fn(async () => ({ id: WS })) };
  const communicationBusinessRepo = makeRepoStub();
  const communicationProfileRepo = makeRepoStub();
  const profilePhoneAssignmentRepo = makeRepoStub();
  const webhookSubscriptionRepo = makeRepoStub();
  const apiKeyRepo = makeRepoStub([
    { id: 'k1', tenantId: TENANT_ID, name: 'LeadBridge Key' },
  ]);

  const encryptionService: any = {
    decrypt: jest.fn(() => ({ accountSid: 'AC', authToken: 'tok' })),
  };
  const twilioProvider: any = {
    purchasePhoneNumber: jest.fn(async () =>
      opts.purchaseSucceeds === false
        ? Promise.reject(new Error('twilio failed'))
        : {
            phoneNumber: '+19998887777',
            sid: 'PNxxx',
            capabilities: (opts as any).twilioCapabilities ?? ['sms', 'voice'],
            friendlyName: 'LB',
          },
    ),
    configureWebhooks: jest.fn(async () => undefined),
    // Wave-2 PR 4: purchase now uses the partial-update method from PR 1
    // for channel-scoped webhook configuration.
    updateNumberWebhooks: jest.fn(async () => ({ success: true, applied: [] })),
  };
  const configService: any = {
    get: jest.fn((key: string) => {
      if (key === 'BASE_URL') return 'https://sigcore.test';
      return undefined;
    }),
  };

  // Task 6B.5A: subaccount provisioner stub. Default: workspace already
  // has usable credentials (returns the integration unchanged). Test-
  // specific overrides can replace this on `opts` to simulate provisioning.
  const subaccountProvisioner: any = {
    ensureReady: jest.fn(async (integrationId: string) => {
      const row = await (integrationRepo as any).findOne({ where: { id: integrationId } });
      return row ?? { credentialsEncrypted: 'stub-creds' };
    }),
  };

  const svc = new PhoneNumberProvisioningService(
    orderRepo as any,
    pricingRepo as any,
    tenantPhoneRepo as any,
    integrationRepo as any,
    tenantRepo as any,
    workspaceRepo as any,
    communicationBusinessRepo as any,
    communicationProfileRepo as any,
    profilePhoneAssignmentRepo as any,
    webhookSubscriptionRepo as any,
    apiKeyRepo as any,
    encryptionService,
    twilioProvider,
    configService,
    subaccountProvisioner,
  );

  // Skip A2P side-effects to keep the test focused on the new
  // outbound-ready hook. attachToMessagingService is a private method;
  // stub it on the instance.
  (svc as any).attachToMessagingService = jest.fn(async () => ({
    success: false,
    error: 'no_messaging_service_configured',
  }));
  // Pricing config — also private. Stub to a deterministic config.
  (svc as any).getPricingConfig = jest.fn(async () => ({
    pricingType: 'fixed',
    monthlyMarkupAmount: 0,
    monthlyMarkupPercentage: 0,
    setupFee: 0,
    allowTenantPurchase: true,
    allowTenantRelease: true,
  }));
  (svc as any).calculatePrice = jest.fn(() => ({
    twilioCost: 1,
    markupAmount: 0,
    totalPrice: 1,
    setupFee: 0,
  }));

  return {
    svc,
    orderRepo,
    tenantPhoneRepo,
    communicationBusinessRepo,
    communicationProfileRepo,
    profilePhoneAssignmentRepo,
    webhookSubscriptionRepo,
    apiKeyRepo,
    tenantRepo,
    twilioProvider,
  };
}

describe('PhoneNumberProvisioningService.purchaseNumber — ensureOutboundReady wiring', () => {
  it('successful Twilio purchase materializes the chain end-to-end', async () => {
    const ctx = buildService();

    const result = await ctx.svc.purchaseNumber(
      WS,
      TENANT_ID,
      '+19998887777',
      undefined,
      'LB',
    );

    expect(result.success).toBe(true);
    expect(result.allocation).toBeDefined();
    // Order completes
    const order = ctx.orderRepo.rows.find((r) => r.status === PhoneNumberOrderStatus.ACTIVE);
    expect(order).toBeDefined();
    expect(order.tenantPhoneNumberId).toBe(result.allocation!.id);
    // Chain created
    expect(ctx.communicationBusinessRepo.rows).toHaveLength(1);
    expect(ctx.communicationProfileRepo.rows).toHaveLength(1);
    expect(ctx.profilePhoneAssignmentRepo.rows).toHaveLength(1);
    expect(ctx.profilePhoneAssignmentRepo.rows[0]).toMatchObject({
      profileId: ctx.communicationProfileRepo.rows[0].id,
      tenantPhoneNumberId: result.allocation!.id,
      active: true,
      isDefault: true,
    });
    // TPN itself is ACTIVE
    expect(result.allocation!.status).toBe(PhoneNumberAllocationStatus.ACTIVE);
  });

  it('chain materialization failure does NOT roll back the Twilio purchase', async () => {
    const ctx = buildService();
    // Force the business repo to throw on save so ensureOutboundReady fails.
    ctx.communicationBusinessRepo.save.mockImplementationOnce(async () => {
      throw new Error('synthetic DB failure');
    });

    const result = await ctx.svc.purchaseNumber(
      WS,
      TENANT_ID,
      '+19998887777',
      undefined,
      'LB',
    );

    // Purchase succeeded; order is ACTIVE; TPN is saved
    expect(result.success).toBe(true);
    expect(result.allocation).toBeDefined();
    const order = ctx.orderRepo.rows.find((r) => r.status === PhoneNumberOrderStatus.ACTIVE);
    expect(order).toBeDefined();
    // Chain is partial / missing — that's the recoverable state
    expect(ctx.profilePhoneAssignmentRepo.rows).toHaveLength(0);
  });

  it('idempotent: a second purchase for the same tenant does not duplicate chain rows', async () => {
    const ctx = buildService();

    await ctx.svc.purchaseNumber(WS, TENANT_ID, '+19998887777', undefined, 'LB-1');
    // Twilio returns a different sid for the second purchase
    ctx.twilioProvider.purchasePhoneNumber.mockImplementationOnce(async () => ({
      phoneNumber: '+19998887778',
      sid: 'PNyyy',
      capabilities: ['sms'],
      friendlyName: 'LB-2',
    }));
    await ctx.svc.purchaseNumber(WS, TENANT_ID, '+19998887778', undefined, 'LB-2');

    expect(ctx.communicationBusinessRepo.rows).toHaveLength(1);
    expect(ctx.communicationProfileRepo.rows).toHaveLength(1);
    // Two PPAs (one per TPN), only the first is default
    expect(ctx.profilePhoneAssignmentRepo.rows).toHaveLength(2);
    const defaults = ctx.profilePhoneAssignmentRepo.rows.filter((p: any) => p.isDefault);
    expect(defaults).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------
// Wave-2 Voice Foundation PR 4 — purchase channel selector.
// -----------------------------------------------------------------------

import { ChannelType } from '../../database/entities/sender.entity';

describe('PhoneNumberProvisioningService.purchaseNumber — channel selector (PR 4)', () => {
  it("omitted channel defaults to 'sms' (backward-compatible)", async () => {
    const ctx = buildService();
    const result = await ctx.svc.purchaseNumber(
      WS,
      TENANT_ID,
      '+19998887777',
      undefined,
      'LB',
    );
    expect(result.success).toBe(true);
    expect(result.allocation!.channel).toBe(ChannelType.SMS);
    // updateNumberWebhooks called with SMS URL only, no voice
    expect(ctx.twilioProvider.updateNumberWebhooks).toHaveBeenCalledTimes(1);
    const urls = (ctx.twilioProvider.updateNumberWebhooks as jest.Mock).mock.calls[0][2];
    expect(urls.smsUrl).toBeDefined();
    expect(urls.voiceUrl).toBeUndefined();
    expect(urls.statusCallbackUrl).toBeUndefined();
    // metadata reflects requested channel + activeChannels
    const meta = result.allocation!.metadata as Record<string, unknown>;
    expect(meta.requestedChannel).toBe('sms');
    expect(meta.activeChannels).toEqual(['sms']);
  });

  it("channel='sms' explicit — SMS-only webhook, TPN.channel=SMS, A2P attempted", async () => {
    const ctx = buildService();
    const attach = (ctx.svc as any).attachToMessagingService as jest.Mock;
    const result = await ctx.svc.purchaseNumber(
      WS,
      TENANT_ID,
      '+19998887777',
      undefined,
      'LB',
      'sms',
    );
    expect(result.success).toBe(true);
    expect(result.allocation!.channel).toBe(ChannelType.SMS);
    const urls = (ctx.twilioProvider.updateNumberWebhooks as jest.Mock).mock.calls[0][2];
    expect(urls.smsUrl).toBeDefined();
    expect(urls.voiceUrl).toBeUndefined();
    expect(attach).toHaveBeenCalledTimes(1); // A2P attempted for SMS
  });

  it("channel='voice' — voice URL + status callback set, SMS untouched, A2P skipped, TPN.channel=VOICE", async () => {
    const ctx = buildService();
    const attach = (ctx.svc as any).attachToMessagingService as jest.Mock;
    const result = await ctx.svc.purchaseNumber(
      WS,
      TENANT_ID,
      '+19998887777',
      undefined,
      'LB',
      'voice',
    );
    expect(result.success).toBe(true);
    expect(result.allocation!.channel).toBe(ChannelType.VOICE);
    const urls = (ctx.twilioProvider.updateNumberWebhooks as jest.Mock).mock.calls[0][2];
    expect(urls.voiceUrl).toBeDefined();
    expect(urls.statusCallbackUrl).toBeDefined();
    expect(urls.smsUrl).toBeUndefined();
    // A2P skipped for voice-only allocations
    expect(attach).not.toHaveBeenCalled();
    // metadata reflects intent
    const meta = result.allocation!.metadata as Record<string, unknown>;
    expect(meta.requestedChannel).toBe('voice');
    expect(meta.activeChannels).toEqual(['voice']);
  });

  it("channel='both' — SMS URL + voice URL + status callback all set, A2P attempted, TPN.channel=SMS, metadata.activeChannels=['sms','voice']", async () => {
    const ctx = buildService();
    const attach = (ctx.svc as any).attachToMessagingService as jest.Mock;
    const result = await ctx.svc.purchaseNumber(
      WS,
      TENANT_ID,
      '+19998887777',
      undefined,
      'LB',
      'both',
    );
    expect(result.success).toBe(true);
    expect(result.allocation!.channel).toBe(ChannelType.SMS);
    const urls = (ctx.twilioProvider.updateNumberWebhooks as jest.Mock).mock.calls[0][2];
    expect(urls.smsUrl).toBeDefined();
    expect(urls.voiceUrl).toBeDefined();
    expect(urls.statusCallbackUrl).toBeDefined();
    expect(attach).toHaveBeenCalledTimes(1);
    const meta = result.allocation!.metadata as Record<string, unknown>;
    expect(meta.requestedChannel).toBe('both');
    expect(meta.activeChannels).toEqual(['sms', 'voice']);
  });

  it("voice requested but Twilio number is SMS-only → BadRequestException", async () => {
    const ctx = buildService({ twilioCapabilities: ['sms'] } as any);
    await expect(
      ctx.svc.purchaseNumber(
        WS,
        TENANT_ID,
        '+19998887777',
        undefined,
        'LB',
        'voice',
      ),
    ).rejects.toThrow(/not voice-capable/i);
  });

  it("sms requested but Twilio number is voice-only → BadRequestException", async () => {
    const ctx = buildService({ twilioCapabilities: ['voice'] } as any);
    await expect(
      ctx.svc.purchaseNumber(
        WS,
        TENANT_ID,
        '+19998887777',
        undefined,
        'LB',
        'sms',
      ),
    ).rejects.toThrow(/not SMS-capable/i);
  });

  it("both requested but Twilio number is SMS-only → BadRequestException", async () => {
    const ctx = buildService({ twilioCapabilities: ['sms'] } as any);
    await expect(
      ctx.svc.purchaseNumber(
        WS,
        TENANT_ID,
        '+19998887777',
        undefined,
        'LB',
        'both',
      ),
    ).rejects.toThrow(/not voice-capable/i);
  });

  it("purchase order metadata records requestedChannel and Twilio-reported capabilities", async () => {
    const ctx = buildService();
    const result = await ctx.svc.purchaseNumber(
      WS,
      TENANT_ID,
      '+19998887777',
      undefined,
      'LB',
      'both',
    );
    const order = ctx.orderRepo.rows.find(
      (r) => r.id === (result.allocation as any).orderId,
    ) as any;
    expect(order.metadata.requestedChannel).toBe('both');
    expect(order.metadata.capabilities).toEqual(['sms', 'voice']);
  });

  it("release/rollback path remains functional — a purchase that fails still marks order FAILED regardless of channel", async () => {
    const ctx = buildService({ purchaseSucceeds: false });
    const result = await ctx.svc.purchaseNumber(
      WS,
      TENANT_ID,
      '+19998887777',
      undefined,
      'LB',
      'voice',
    );
    expect(result.success).toBe(false);
    const failedOrder = ctx.orderRepo.rows.find(
      (r) => r.status === PhoneNumberOrderStatus.FAILED,
    );
    expect(failedOrder).toBeDefined();
    expect(ctx.tenantPhoneRepo.rows).toHaveLength(0); // no TPN persisted
  });
});
