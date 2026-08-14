/**
 * PhoneNumberProvisioningService.updateAllocationChannel — PATCH endpoint
 * service tests. Covers the Globus 2026-08 audit fix: allow ops to promote
 * a TPN from SMS-only to voice-enabled in place without DELETE + repurchase.
 * See docs/AUDIT_TPN_ACTIVECHANNELS_STUCK.md.
 */
import { PhoneNumberProvisioningService } from './phone-number-provisioning.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { ChannelType } from '../../database/entities/sender.entity';
import { IntegrationStatus, ProviderType } from '../../database/entities/communication-integration.entity';

const WS = '1bcbb4e0-df1b-481c-83ba-0730df47a720';
const TENANT_ID = '7ae06bb6-90ee-475f-8346-289b11912e3f';
const ALLOC_ID = 'alloc-1';
const PHONE = '+19998887777';
const PROVIDER_SID = 'PNxxx';

function buildService(opts: {
  allocationMetadata?: any;
  allocationChannel?: ChannelType;
  twilioUpdateSucceeds?: boolean;
  twilioUpdateApplied?: string[];
  integrationMissing?: boolean;
  twilioFetchResult?: { phoneNumber: string; capabilities: { voice: boolean; sms: boolean; mms: boolean } } | null;
} = {}) {
  const allocation = opts.integrationMissing || opts.allocationMetadata === 'missing'
    ? null
    : {
        id: ALLOC_ID,
        workspaceId: WS,
        tenantId: TENANT_ID,
        phoneNumber: PHONE,
        providerId: PROVIDER_SID,
        channel: opts.allocationChannel ?? ChannelType.SMS,
        // Use hasOwnProperty (not ??) so an explicit `null` from a test
        // (legacy-BYO shape) is preserved and doesn't fall back to the default.
        metadata: Object.prototype.hasOwnProperty.call(opts, 'allocationMetadata')
          ? opts.allocationMetadata
          : {
              requestedChannel: 'sms',
              activeChannels: ['sms'],
              capabilities: ['sms', 'voice'],
            },
      };

  const tenantPhoneRepo = {
    findOne: jest.fn(async () => allocation),
    save: jest.fn(async (a: any) => a),
  };
  const integrationRepo = {
    findOne: jest.fn(async () =>
      opts.integrationMissing
        ? null
        : {
            id: 'int-1',
            workspaceId: WS,
            provider: ProviderType.TWILIO,
            status: IntegrationStatus.ACTIVE,
            credentialsEncrypted: 'enc',
          },
    ),
  };
  const encryptionService: any = { decrypt: jest.fn(() => 'creds-json') };
  const twilioProvider: any = {
    updateNumberWebhooks: jest.fn(async () => ({
      success: opts.twilioUpdateSucceeds !== false,
      applied: opts.twilioUpdateApplied ?? ['voiceUrl', 'statusCallbackUrl'],
      error: opts.twilioUpdateSucceeds === false ? 'twilio_error' : undefined,
    })),
    fetchPhoneNumberBySid: jest.fn(async (_c: string, sid: string) =>
      opts.twilioFetchResult === undefined
        ? { sid, phoneNumber: PHONE, friendlyName: 'test', capabilities: { voice: true, sms: true, mms: true } }
        : opts.twilioFetchResult,
    ),
  };
  const configService: any = {
    get: jest.fn((k: string) => (k === 'BASE_URL' ? 'https://sigcore.test' : undefined)),
  };

  // Repos we don't exercise but the constructor requires.
  const noopRepo = { findOne: jest.fn(), find: jest.fn(), create: jest.fn(), save: jest.fn() };

  const svc = new PhoneNumberProvisioningService(
    noopRepo as any, // orderRepo
    noopRepo as any, // pricingRepo
    tenantPhoneRepo as any,
    integrationRepo as any,
    noopRepo as any, // tenantRepo
    noopRepo as any, // workspaceRepo
    noopRepo as any, // communicationBusinessRepo
    noopRepo as any, // communicationProfileRepo
    noopRepo as any, // profilePhoneAssignmentRepo
    noopRepo as any, // webhookSubscriptionRepo
    noopRepo as any, // apiKeyRepo
    encryptionService,
    twilioProvider,
    configService,
    { ensureReady: jest.fn() } as any, // subaccountProvisioner
  );
  // Suppress ensureOutboundReady side effects — its own tests cover that flow.
  (svc as any).ensureOutboundReady = jest.fn(async () => undefined);

  return { svc, tenantPhoneRepo, integrationRepo, twilioProvider };
}

describe('PhoneNumberProvisioningService.updateAllocationChannel', () => {
  it('throws NotFoundException when allocation does not exist', async () => {
    const { svc } = buildService({ allocationMetadata: 'missing' });
    await expect(
      svc.updateAllocationChannel(WS, TENANT_ID, 'nope', 'both'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('IDEMPOTENT — no-op when requested channel matches current requestedChannel', async () => {
    const { svc, tenantPhoneRepo, twilioProvider } = buildService({
      allocationMetadata: {
        requestedChannel: 'both',
        activeChannels: ['sms', 'voice'],
        capabilities: ['sms', 'voice'],
      },
    });
    await svc.updateAllocationChannel(WS, TENANT_ID, ALLOC_ID, 'both');
    // Neither DB write nor Twilio call fires when there's nothing to change.
    expect(tenantPhoneRepo.save).not.toHaveBeenCalled();
    expect(twilioProvider.updateNumberWebhooks).not.toHaveBeenCalled();
  });

  it('REJECTS enabling a channel not in Twilio capabilities (voice on SMS-only number)', async () => {
    const { svc } = buildService({
      allocationMetadata: {
        requestedChannel: 'sms',
        activeChannels: ['sms'],
        capabilities: ['sms'], // Twilio number literally cannot do voice
      },
    });
    await expect(
      svc.updateAllocationChannel(WS, TENANT_ID, ALLOC_ID, 'both'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('UPGRADE sms → both — updates Twilio voice URL, persists metadata + column', async () => {
    // Globus shape: SMS-only allocation, underlying Twilio supports voice.
    const { svc, tenantPhoneRepo, twilioProvider } = buildService({
      allocationMetadata: {
        requestedChannel: 'sms',
        activeChannels: ['sms'],
        capabilities: ['sms', 'voice'],
      },
    });

    const result = await svc.updateAllocationChannel(WS, TENANT_ID, ALLOC_ID, 'both');

    // Twilio: voice URL + status callback were set. SMS URL preserved (not
    // in the diff — was already active).
    expect(twilioProvider.updateNumberWebhooks).toHaveBeenCalledWith(
      'creds-json',
      PROVIDER_SID,
      expect.objectContaining({
        voiceUrl: `https://sigcore.test/api/webhooks/twilio/voice/${WS}`,
        statusCallbackUrl: 'https://sigcore.test/api/webhooks/twilio/voice/status',
      }),
    );
    // Sanity: NO smsUrl in the diff (already active, don't re-configure).
    const urls = twilioProvider.updateNumberWebhooks.mock.calls[0][2];
    expect(urls.smsUrl).toBeUndefined();

    // DB: metadata carries the new intent + activeChannels; column stays SMS
    // per the purchase-time 'both'→SMS mapping.
    expect(tenantPhoneRepo.save).toHaveBeenCalled();
    expect(result.metadata).toMatchObject({
      requestedChannel: 'both',
      activeChannels: ['sms', 'voice'],
      capabilities: ['sms', 'voice'], // preserved verbatim
    });
    expect(result.channel).toBe(ChannelType.SMS);
  });

  it('UPGRADE sms → voice — column flips to VOICE per purchase-time mapping', async () => {
    const { svc, twilioProvider } = buildService({
      allocationMetadata: {
        requestedChannel: 'sms',
        activeChannels: ['sms'],
        capabilities: ['sms', 'voice'],
      },
    });
    const result = await svc.updateAllocationChannel(WS, TENANT_ID, ALLOC_ID, 'voice');
    expect(result.channel).toBe(ChannelType.VOICE);
    expect(result.metadata).toMatchObject({
      requestedChannel: 'voice',
      activeChannels: ['voice'],
    });
    // Voice URL was added.
    const urls = twilioProvider.updateNumberWebhooks.mock.calls[0][2];
    expect(urls.voiceUrl).toBeDefined();
  });

  it('ROLLBACK — does NOT persist metadata when Twilio update fails', async () => {
    // Preventing the exact silent-failure class this audit is fixing: if we
    // stored activeChannels=['sms','voice'] but Twilio never got the voice
    // URL, Sigcore's guards would pass but Twilio would fail the actual call.
    const { svc, tenantPhoneRepo } = buildService({
      allocationMetadata: {
        requestedChannel: 'sms',
        activeChannels: ['sms'],
        capabilities: ['sms', 'voice'],
      },
      twilioUpdateSucceeds: false,
    });
    await expect(
      svc.updateAllocationChannel(WS, TENANT_ID, ALLOC_ID, 'both'),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Critical: no DB save happened.
    expect(tenantPhoneRepo.save).not.toHaveBeenCalled();
  });

  it('REJECTS when workspace has no active Twilio integration', async () => {
    const { svc, tenantPhoneRepo } = buildService({ integrationMissing: true });
    // buildService returns null-alloc when integrationMissing, so seed one
    // manually so we get past the 404 branch.
    (tenantPhoneRepo.findOne as jest.Mock).mockResolvedValue({
      id: ALLOC_ID,
      workspaceId: WS,
      tenantId: TENANT_ID,
      phoneNumber: PHONE,
      providerId: PROVIDER_SID,
      channel: ChannelType.SMS,
      metadata: { requestedChannel: 'sms', activeChannels: ['sms'], capabilities: ['sms', 'voice'] },
    });
    await expect(
      svc.updateAllocationChannel(WS, TENANT_ID, ALLOC_ID, 'both'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tenantPhoneRepo.save).not.toHaveBeenCalled();
  });

  // ─── preserveWebhooks (metadata-only normalization for legacy BYO TPNs) ──
  //
  // 2026-08-14 Spotless Homes case: TPN 0a0a5951 created 2026-03-08,
  // metadata=null (predates Wave-2 PR 4), Twilio caps=voice/sms/mms.
  // Need to backfill Sigcore metadata to reflect Twilio reality WITHOUT
  // rewriting the Twilio-side voiceUrl (which points at a demo route and
  // whose replacement is the separate inbound-agent rollout's concern).
  describe('preserveWebhooks (metadata-only normalize)', () => {
    it('SKIPS Twilio webhook update when preserveWebhooks=true; metadata is written and capabilities backfilled from live Twilio fetch', async () => {
      const { svc, tenantPhoneRepo, twilioProvider } = buildService({
        // Legacy TPN: null metadata, all defaults.
        allocationMetadata: null,
      });
      const result = await svc.updateAllocationChannel(WS, TENANT_ID, ALLOC_ID, 'both', {
        preserveWebhooks: true,
      });
      // Twilio webhooks NOT touched.
      expect(twilioProvider.updateNumberWebhooks).not.toHaveBeenCalled();
      // Twilio SID fetch WAS invoked to authoritatively backfill capabilities.
      expect(twilioProvider.fetchPhoneNumberBySid).toHaveBeenCalledWith(
        'creds-json',
        PROVIDER_SID,
      );
      // DB write happened with capabilities backfilled from Twilio.
      expect(tenantPhoneRepo.save).toHaveBeenCalled();
      expect(result.metadata).toMatchObject({
        activeChannels: ['sms', 'voice'],
        requestedChannel: 'both',
        capabilities: ['sms', 'voice'],
      });
    });

    it('DOES NOT skip Twilio webhook update when preserveWebhooks is absent or false (existing behavior)', async () => {
      const { svc, twilioProvider } = buildService({
        allocationMetadata: {
          requestedChannel: 'sms',
          activeChannels: ['sms'],
          capabilities: ['sms', 'voice'],
        },
      });
      await svc.updateAllocationChannel(WS, TENANT_ID, ALLOC_ID, 'both');
      expect(twilioProvider.updateNumberWebhooks).toHaveBeenCalled();
    });

    it('REJECTS in preserveWebhooks mode when Twilio SID resolves to a different phone number (identity mismatch)', async () => {
      const { svc, tenantPhoneRepo } = buildService({
        allocationMetadata: null,
        twilioFetchResult: {
          phoneNumber: '+15555550000', // different from PHONE
          capabilities: { voice: true, sms: true, mms: true },
        },
      });
      await expect(
        svc.updateAllocationChannel(WS, TENANT_ID, ALLOC_ID, 'both', { preserveWebhooks: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tenantPhoneRepo.save).not.toHaveBeenCalled();
    });

    it('REJECTS in preserveWebhooks mode when Twilio fetch returns null (no authoritative caps → refuse to claim voice)', async () => {
      const { svc, tenantPhoneRepo } = buildService({
        allocationMetadata: null,
        twilioFetchResult: null,
      });
      await expect(
        svc.updateAllocationChannel(WS, TENANT_ID, ALLOC_ID, 'both', { preserveWebhooks: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tenantPhoneRepo.save).not.toHaveBeenCalled();
    });

    it('REJECTS in preserveWebhooks mode when Twilio caps do not include the requested channel', async () => {
      const { svc, tenantPhoneRepo } = buildService({
        allocationMetadata: null,
        twilioFetchResult: {
          phoneNumber: PHONE,
          capabilities: { voice: false, sms: true, mms: true },
        },
      });
      await expect(
        svc.updateAllocationChannel(WS, TENANT_ID, ALLOC_ID, 'both', { preserveWebhooks: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tenantPhoneRepo.save).not.toHaveBeenCalled();
    });
  });
});
