/**
 * Wave-2 Task 4 — PhoneNumbersService.configureWebhooks (PR-1).
 *
 * Runbook tests:
 *   - empty body → 400
 *   - voice-only update preserves SMS state (Twilio REST preserve semantics)
 *   - sms-only update preserves voice state
 *   - voiceFallbackUrl reaches Twilio when supplied (PR-1 correction)
 *   - statusCallbackUrl reaches Twilio when supplied (PR-1 correction)
 *   - full combination reaches Twilio verbatim
 *   - Twilio failure surfaces as 502
 *   - metadata.webhookConfig persisted
 *   - TPN not found → 404
 *   - TPN missing providerId → 400
 *   - Integration not found → 404
 */

import {
  BadRequestException,
  BadGatewayException,
  NotFoundException,
} from '@nestjs/common';
import { PhoneNumbersService } from './phone-numbers.service';

function repo() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    save: jest.fn(async (x: any) => x),
    create: jest.fn(),
  };
}

function buildService(
  overrides: { twilio?: any; tpn?: any; integration?: any } = {},
) {
  const integrationRepo = repo();
  const senderRepo = repo();
  const tpnRepo = repo();
  const encryptionService = {
    encrypt: jest.fn(),
    decrypt: jest.fn(() =>
      JSON.stringify({ accountSid: 'AC', authToken: 't' }),
    ),
  };
  const twilioProvider = overrides.twilio ?? {
    // The new flexible partial-update method used by configureWebhooks.
    updateNumberWebhooks: jest.fn(async () => ({ success: true, applied: [] })),
    // Retained on the mock for backward-compat with unrelated callers,
    // but configureWebhooks no longer calls these two.
    configureWebhooks: jest.fn(),
    updateSmsWebhook: jest.fn(),
  };

  tpnRepo.findOne.mockResolvedValue(
    overrides.tpn ?? {
      id: 'tpn-1',
      workspaceId: 'ws-1',
      tenantId: 'tenant-1',
      providerId: 'PN123',
      phoneNumber: '+15551230000',
      metadata: {},
    },
  );
  integrationRepo.findOne.mockResolvedValue(
    overrides.integration ?? {
      id: 'int-1',
      workspaceId: 'ws-1',
      provider: 'twilio',
      credentialsEncrypted: 'enc',
      metadata: {},
    },
  );

  const svc = new PhoneNumbersService(
    integrationRepo as any,
    senderRepo as any,
    tpnRepo as any,
    encryptionService as any,
    twilioProvider as any,
  );
  return { svc, twilioProvider, tpnRepo, integrationRepo };
}

describe('PhoneNumbersService.configureWebhooks', () => {
  it('empty body returns 400', async () => {
    const { svc } = buildService();
    await expect(
      svc.configureWebhooks('tpn-1', { integrationId: 'int-1' } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('voice-only: only voiceUrl is sent to Twilio; smsUrl NOT included in the update payload', async () => {
    const { svc, twilioProvider, tpnRepo } = buildService();
    const result = await svc.configureWebhooks('tpn-1', {
      integrationId: 'int-1',
      voiceUrl: 'https://x/voice',
    });
    expect(result.applied.voiceUrl).toBe('https://x/voice');
    expect(result.applied.smsUrl).toBeUndefined();
    // Provider called with a partial URLs object — voiceUrl only, no smsUrl.
    expect(twilioProvider.updateNumberWebhooks).toHaveBeenCalledTimes(1);
    const [, sid, urls] = (
      twilioProvider.updateNumberWebhooks as jest.Mock
    ).mock.calls[0];
    expect(sid).toBe('PN123');
    expect(urls).toEqual({
      voiceUrl: 'https://x/voice',
      smsUrl: undefined,
      voiceFallbackUrl: undefined,
      statusCallbackUrl: undefined,
    });
    expect(tpnRepo.save).toHaveBeenCalledTimes(1);
    const saved = (tpnRepo.save as jest.Mock).mock.calls[0][0];
    expect(saved.metadata.webhookConfig.voiceUrl).toBe('https://x/voice');
    expect(saved.metadata.webhookConfig.smsUrl).toBeUndefined();
  });

  it('sms-only: only smsUrl is sent to Twilio', async () => {
    const { svc, twilioProvider } = buildService();
    await svc.configureWebhooks('tpn-1', {
      integrationId: 'int-1',
      smsUrl: 'https://x/sms',
    });
    expect(twilioProvider.updateNumberWebhooks).toHaveBeenCalledTimes(1);
    const [, , urls] = (
      twilioProvider.updateNumberWebhooks as jest.Mock
    ).mock.calls[0];
    expect(urls.smsUrl).toBe('https://x/sms');
    expect(urls.voiceUrl).toBeUndefined();
  });

  it('voiceFallbackUrl is applied to Twilio when supplied (PR-1 correction)', async () => {
    const { svc, twilioProvider, tpnRepo } = buildService();
    const result = await svc.configureWebhooks('tpn-1', {
      integrationId: 'int-1',
      voiceFallbackUrl: 'https://x/voice-fallback',
    });
    expect(result.applied.voiceFallbackUrl).toBe('https://x/voice-fallback');
    const [, , urls] = (
      twilioProvider.updateNumberWebhooks as jest.Mock
    ).mock.calls[0];
    expect(urls.voiceFallbackUrl).toBe('https://x/voice-fallback');
    const saved = (tpnRepo.save as jest.Mock).mock.calls[0][0];
    expect(saved.metadata.webhookConfig.voiceFallbackUrl).toBe(
      'https://x/voice-fallback',
    );
  });

  it('statusCallbackUrl is applied to Twilio when supplied (PR-1 correction)', async () => {
    const { svc, twilioProvider, tpnRepo } = buildService();
    const result = await svc.configureWebhooks('tpn-1', {
      integrationId: 'int-1',
      statusCallbackUrl: 'https://x/status',
    });
    expect(result.applied.statusCallbackUrl).toBe('https://x/status');
    const [, , urls] = (
      twilioProvider.updateNumberWebhooks as jest.Mock
    ).mock.calls[0];
    expect(urls.statusCallbackUrl).toBe('https://x/status');
    const saved = (tpnRepo.save as jest.Mock).mock.calls[0][0];
    expect(saved.metadata.webhookConfig.statusCallbackUrl).toBe(
      'https://x/status',
    );
  });

  it('full combination: voiceUrl + voiceFallbackUrl + smsUrl + statusCallbackUrl all reach Twilio in one call', async () => {
    const { svc, twilioProvider } = buildService();
    await svc.configureWebhooks('tpn-1', {
      integrationId: 'int-1',
      voiceUrl: 'https://v',
      voiceFallbackUrl: 'https://vf',
      smsUrl: 'https://s',
      statusCallbackUrl: 'https://sc',
    });
    expect(twilioProvider.updateNumberWebhooks).toHaveBeenCalledTimes(1);
    const [, , urls] = (
      twilioProvider.updateNumberWebhooks as jest.Mock
    ).mock.calls[0];
    expect(urls).toEqual({
      voiceUrl: 'https://v',
      voiceFallbackUrl: 'https://vf',
      smsUrl: 'https://s',
      statusCallbackUrl: 'https://sc',
    });
  });

  it('Twilio failure surfaces as 502 (BadGateway)', async () => {
    const twilio = {
      updateNumberWebhooks: jest.fn(async () => ({
        success: false,
        applied: [],
        error: 'twilio 500',
      })),
    };
    const { svc } = buildService({ twilio });
    await expect(
      svc.configureWebhooks('tpn-1', {
        integrationId: 'int-1',
        voiceUrl: 'https://v',
        smsUrl: 'https://s',
      }),
    ).rejects.toThrow(BadGatewayException);
  });

  it('TPN not found → 404', async () => {
    const { svc, tpnRepo } = buildService();
    tpnRepo.findOne.mockResolvedValue(null);
    await expect(
      svc.configureWebhooks('missing-tpn', {
        integrationId: 'int-1',
        voiceUrl: 'https://x',
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('TPN with no providerId → 400', async () => {
    const { svc } = buildService({
      tpn: {
        id: 'tpn-1',
        workspaceId: 'ws-1',
        tenantId: 'tenant-1',
        providerId: null,
        phoneNumber: '+15551230000',
        metadata: {},
      },
    });
    await expect(
      svc.configureWebhooks('tpn-1', {
        integrationId: 'int-1',
        voiceUrl: 'https://x',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('integration not found → 404', async () => {
    const { svc, integrationRepo } = buildService();
    integrationRepo.findOne.mockResolvedValue(null);
    await expect(
      svc.configureWebhooks('tpn-1', {
        integrationId: 'int-1',
        voiceUrl: 'https://x',
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('metadata.webhookConfig merges with prior config (does not clobber unrelated keys)', async () => {
    const { svc, tpnRepo } = buildService({
      tpn: {
        id: 'tpn-1',
        workspaceId: 'ws-1',
        tenantId: 'tenant-1',
        providerId: 'PN123',
        phoneNumber: '+15551230000',
        metadata: {
          voice: true,
          webhookConfig: { smsUrl: 'https://old/sms', configuredAt: 'prior' },
        },
      },
    });
    await svc.configureWebhooks('tpn-1', {
      integrationId: 'int-1',
      voiceUrl: 'https://new/voice',
    });
    const saved = (tpnRepo.save as jest.Mock).mock.calls[0][0];
    expect(saved.metadata.voice).toBe(true); // unrelated key survives
    expect(saved.metadata.webhookConfig.smsUrl).toBe('https://old/sms'); // prior sms url retained
    expect(saved.metadata.webhookConfig.voiceUrl).toBe('https://new/voice'); // new voice url layered on top
    expect(saved.metadata.webhookConfig.configuredAt).not.toBe('prior'); // timestamp refreshed
  });
});
