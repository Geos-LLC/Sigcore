import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import {
  CommunicationIntegration,
  ProviderType,
} from '../../database/entities/communication-integration.entity';
import { Workspace } from '../../database/entities/workspace.entity';
import { EncryptionService } from '../../common/services/encryption.service';
import type { TwilioProvider } from '../communication/providers/twilio.provider';
import { TwilioVoiceProvisionerService } from './twilio-voice-provisioner.service';

// Feature 2 — TwilioVoiceProvisionerService unit tests.
//
// Covers the four operational paths:
//   1. Full idempotent no-op (both creds already present)
//   2. Partial state (API Key present, TwiML App missing — and vice versa)
//   3. First-time provisioning (neither present, both created)
//   4. Failure paths (missing base creds, wrong provider, wrong workspace,
//      Twilio errors) — verify they throw the right exception and no secrets
//      leak into responses/logs.

// ---------------------------------------------------------------------------
// Fake DataSource with pessimistic-lock transaction shape
// ---------------------------------------------------------------------------
function makeDataSource(rows: {
  integration?: CommunicationIntegration | null;
  workspace?: Workspace | null;
}) {
  const savedIntegrations: CommunicationIntegration[] = [];

  const integrationRepo = {
    createQueryBuilder: jest.fn(() => ({
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(rows.integration ?? null),
    })),
    save: jest.fn(async (i: CommunicationIntegration) => {
      savedIntegrations.push(i);
      return i;
    }),
  };
  const workspaceRepo = {
    findOne: jest.fn().mockResolvedValue(rows.workspace ?? null),
  };

  const dataSource = {
    transaction: jest.fn(async (cb: any) => {
      const mgr = {
        getRepository: (target: any) =>
          target === Workspace ? workspaceRepo : integrationRepo,
      };
      return cb(mgr);
    }),
  } as unknown as DataSource;

  return { dataSource, integrationRepo, workspaceRepo, savedIntegrations };
}

// Real EncryptionService uses CryptoJS AES (OpenSSL-compatible). Give it a
// deterministic ConfigService so the same key is used across encrypt/decrypt
// calls in the same test.
function makeEncryption(): EncryptionService {
  const testCfg = {
    get: (k: string) => (k === 'ENCRYPTION_KEY' ? 'test-encryption-key-1234567890abcdef' : undefined),
  } as unknown as ConfigService;
  return new EncryptionService(testCfg);
}

function makeIntegration(
  overrides: Partial<CommunicationIntegration> = {},
): CommunicationIntegration {
  return {
    id: 'int-1',
    workspaceId: 'ws-1',
    provider: ProviderType.TWILIO,
    credentialsEncrypted: '',
    ...overrides,
  } as CommunicationIntegration;
}

const cfg = (values: Record<string, string | undefined> = {}) =>
  ({
    get: <T = string>(k: string): T | undefined => values[k] as T | undefined,
  }) as unknown as ConfigService;

function buildTwilioProvider(overrides: {
  createApiKey?: jest.Mock;
  createTwiMLApp?: jest.Mock;
} = {}) {
  return {
    createApiKey:
      overrides.createApiKey ??
      jest.fn().mockResolvedValue({
        success: true,
        apiKey: { sid: 'SK1111111111111111111111111111abcd', secret: 'secret_x' },
      }),
    createTwiMLApp:
      overrides.createTwiMLApp ??
      jest.fn().mockResolvedValue({
        success: true,
        twimlApp: { sid: 'AP2222222222222222222222222222abcd' },
      }),
  } as unknown as TwilioProvider;
}

describe('TwilioVoiceProvisionerService', () => {
  describe('happy paths + idempotency', () => {
    it('first-time provisioning: creates API Key + TwiML App, encrypts merged creds, returns masked SIDs', async () => {
      const encryption = makeEncryption();
      const initialCreds = {
        accountSid: 'ACtestacct',
        authToken: 'test_auth_token',
      };
      const integration = makeIntegration({
        credentialsEncrypted: encryption.encrypt(JSON.stringify(initialCreds)),
      });
      const workspace = { id: 'ws-1', webhookId: 'wh-abc' } as Workspace;
      const { dataSource, integrationRepo, savedIntegrations } = makeDataSource({
        integration,
        workspace,
      });
      const twilio = buildTwilioProvider();
      const svc = new TwilioVoiceProvisionerService(
        dataSource,
        encryption,
        twilio,
        cfg({ BASE_URL: 'https://sigcore.test' }),
      );

      const result = await svc.provisionVoice('int-1', 'ws-1');

      // Twilio calls made with the correct arguments
      expect(twilio.createApiKey).toHaveBeenCalledWith(
        JSON.stringify({ accountSid: 'ACtestacct', authToken: 'test_auth_token' }),
        'Sigcore-Callio-Voice-ws-1',
      );
      expect(twilio.createTwiMLApp).toHaveBeenCalledWith(
        JSON.stringify({ accountSid: 'ACtestacct', authToken: 'test_auth_token' }),
        'Sigcore-Callio-Voice-ws-1',
        'https://sigcore.test/api/webhooks/twilio/voice/wh-abc',
      );

      // Row saved once, credentials merged
      expect(integrationRepo.save).toHaveBeenCalledTimes(1);
      const savedCreds = JSON.parse(
        encryption.decrypt(savedIntegrations[0].credentialsEncrypted),
      );
      expect(savedCreds).toMatchObject({
        accountSid: 'ACtestacct',
        authToken: 'test_auth_token',
        voiceApiKey: 'SK1111111111111111111111111111abcd',
        voiceApiSecret: 'secret_x',
        voiceTwimlAppSid: 'AP2222222222222222222222222222abcd',
      });

      // Response is masked
      expect(result).toEqual({
        provisioned: true,
        apiKeyCreated: true,
        twimlAppEnsured: true,
        voiceApiKeySidPrefix: 'SK1111...abcd',
        voiceTwimlAppSid: 'AP2222222222222222222222222222abcd',
        twimlAppVoiceUrl: 'https://sigcore.test/api/webhooks/twilio/voice/wh-abc',
      });
      // Response NEVER echoes secrets
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('secret_x');
      expect(serialized).not.toContain('test_auth_token');
    });

    it('idempotent no-op: both creds already present → no Twilio calls, no DB save', async () => {
      const encryption = makeEncryption();
      const creds = {
        accountSid: 'ACtestacct',
        authToken: 'test_auth_token',
        voiceApiKey: 'SK9999999999999999999999999999cafe',
        voiceApiSecret: 'preexisting_secret',
        voiceTwimlAppSid: 'AP8888888888888888888888888888face',
      };
      const integration = makeIntegration({
        credentialsEncrypted: encryption.encrypt(JSON.stringify(creds)),
      });
      const workspace = { id: 'ws-1', webhookId: 'wh-abc' } as Workspace;
      const { dataSource, integrationRepo } = makeDataSource({ integration, workspace });
      const twilio = buildTwilioProvider();
      const svc = new TwilioVoiceProvisionerService(
        dataSource,
        encryption,
        twilio,
        cfg({ BASE_URL: 'https://sigcore.test' }),
      );

      const result = await svc.provisionVoice('int-1', 'ws-1');

      expect(twilio.createApiKey).not.toHaveBeenCalled();
      expect(twilio.createTwiMLApp).not.toHaveBeenCalled();
      expect(integrationRepo.save).not.toHaveBeenCalled();
      expect(result).toEqual({
        provisioned: true,
        apiKeyCreated: false,
        twimlAppEnsured: false,
        voiceApiKeySidPrefix: 'SK9999...cafe',
        voiceTwimlAppSid: 'AP8888888888888888888888888888face',
        twimlAppVoiceUrl: 'https://sigcore.test/api/webhooks/twilio/voice/wh-abc',
      });
    });

    it('partial state: API Key present, TwiML App missing → creates only TwiML App', async () => {
      const encryption = makeEncryption();
      const creds = {
        accountSid: 'ACtestacct',
        authToken: 'test_auth_token',
        voiceApiKey: 'SK7777777777777777777777777777bbbb',
        voiceApiSecret: 'existing_secret',
      };
      const integration = makeIntegration({
        credentialsEncrypted: encryption.encrypt(JSON.stringify(creds)),
      });
      const workspace = { id: 'ws-1', webhookId: 'wh-abc' } as Workspace;
      const { dataSource } = makeDataSource({ integration, workspace });
      const twilio = buildTwilioProvider();
      const svc = new TwilioVoiceProvisionerService(
        dataSource,
        encryption,
        twilio,
        cfg({ BASE_URL: 'https://sigcore.test' }),
      );

      const result = await svc.provisionVoice('int-1', 'ws-1');

      expect(twilio.createApiKey).not.toHaveBeenCalled();
      expect(twilio.createTwiMLApp).toHaveBeenCalledTimes(1);
      expect(result.apiKeyCreated).toBe(false);
      expect(result.twimlAppEnsured).toBe(true);
      expect(result.voiceApiKeySidPrefix).toBe('SK7777...bbbb');
    });

    it('partial state: TwiML App present, API Key missing → creates only API Key', async () => {
      const encryption = makeEncryption();
      const creds = {
        accountSid: 'ACtestacct',
        authToken: 'test_auth_token',
        voiceTwimlAppSid: 'AP3333333333333333333333333333dddd',
      };
      const integration = makeIntegration({
        credentialsEncrypted: encryption.encrypt(JSON.stringify(creds)),
      });
      const workspace = { id: 'ws-1', webhookId: 'wh-abc' } as Workspace;
      const { dataSource } = makeDataSource({ integration, workspace });
      const twilio = buildTwilioProvider();
      const svc = new TwilioVoiceProvisionerService(
        dataSource,
        encryption,
        twilio,
        cfg({ BASE_URL: 'https://sigcore.test' }),
      );

      const result = await svc.provisionVoice('int-1', 'ws-1');

      expect(twilio.createApiKey).toHaveBeenCalledTimes(1);
      expect(twilio.createTwiMLApp).not.toHaveBeenCalled();
      expect(result.apiKeyCreated).toBe(true);
      expect(result.twimlAppEnsured).toBe(false);
      expect(result.voiceTwimlAppSid).toBe('AP3333333333333333333333333333dddd');
    });
  });

  describe('authorization + ownership', () => {
    it('404 when integration not found', async () => {
      const encryption = makeEncryption();
      const { dataSource } = makeDataSource({ integration: null });
      const svc = new TwilioVoiceProvisionerService(
        dataSource,
        encryption,
        buildTwilioProvider(),
        cfg(),
      );
      await expect(svc.provisionVoice('int-missing', 'ws-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('403 when caller workspaceId does not match the integration owner', async () => {
      const encryption = makeEncryption();
      const integration = makeIntegration({ workspaceId: 'ws-OTHER' });
      const { dataSource } = makeDataSource({ integration });
      const svc = new TwilioVoiceProvisionerService(
        dataSource,
        encryption,
        buildTwilioProvider(),
        cfg(),
      );
      await expect(svc.provisionVoice('int-1', 'ws-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('409 when provider is not twilio', async () => {
      const encryption = makeEncryption();
      const integration = makeIntegration({ provider: ProviderType.OPENPHONE });
      const { dataSource } = makeDataSource({ integration });
      const svc = new TwilioVoiceProvisionerService(
        dataSource,
        encryption,
        buildTwilioProvider(),
        cfg(),
      );
      await expect(svc.provisionVoice('int-1', 'ws-1')).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('missing base state', () => {
    it('409 when integration has no encrypted credentials', async () => {
      const encryption = makeEncryption();
      const integration = makeIntegration({ credentialsEncrypted: '' });
      const { dataSource } = makeDataSource({ integration });
      const svc = new TwilioVoiceProvisionerService(
        dataSource,
        encryption,
        buildTwilioProvider(),
        cfg(),
      );
      await expect(svc.provisionVoice('int-1', 'ws-1')).rejects.toThrow(
        /no credentials yet/i,
      );
    });

    it('409 when decrypted credentials lack accountSid or authToken', async () => {
      const encryption = makeEncryption();
      const integration = makeIntegration({
        credentialsEncrypted: encryption.encrypt(JSON.stringify({ accountSid: 'ACx' })),
      });
      const { dataSource } = makeDataSource({ integration });
      const svc = new TwilioVoiceProvisionerService(
        dataSource,
        encryption,
        buildTwilioProvider(),
        cfg(),
      );
      await expect(svc.provisionVoice('int-1', 'ws-1')).rejects.toThrow(
        /missing accountSid or authToken/i,
      );
    });

    it('409 when workspace has no webhookId', async () => {
      const encryption = makeEncryption();
      const integration = makeIntegration({
        credentialsEncrypted: encryption.encrypt(
          JSON.stringify({ accountSid: 'AC', authToken: 't' }),
        ),
      });
      const { dataSource } = makeDataSource({
        integration,
        workspace: { id: 'ws-1' } as Workspace,
      });
      const svc = new TwilioVoiceProvisionerService(
        dataSource,
        encryption,
        buildTwilioProvider(),
        cfg(),
      );
      await expect(svc.provisionVoice('int-1', 'ws-1')).rejects.toThrow(
        /webhookId/i,
      );
    });
  });

  describe('Twilio provider failures', () => {
    it('502 when createApiKey fails; row is NOT updated (transaction rollback semantics)', async () => {
      const encryption = makeEncryption();
      const integration = makeIntegration({
        credentialsEncrypted: encryption.encrypt(
          JSON.stringify({ accountSid: 'AC', authToken: 't' }),
        ),
      });
      const workspace = { id: 'ws-1', webhookId: 'wh-abc' } as Workspace;
      const { dataSource, integrationRepo } = makeDataSource({ integration, workspace });
      const twilio = buildTwilioProvider({
        createApiKey: jest
          .fn()
          .mockResolvedValue({ success: false, error: 'auth failed' }),
      });
      const svc = new TwilioVoiceProvisionerService(
        dataSource,
        encryption,
        twilio,
        cfg({ BASE_URL: 'https://sigcore.test' }),
      );

      await expect(svc.provisionVoice('int-1', 'ws-1')).rejects.toThrow(
        BadGatewayException,
      );
      expect(integrationRepo.save).not.toHaveBeenCalled();
    });

    it('502 when createTwiMLApp fails after API Key was created — row not updated', async () => {
      const encryption = makeEncryption();
      const integration = makeIntegration({
        credentialsEncrypted: encryption.encrypt(
          JSON.stringify({ accountSid: 'AC', authToken: 't' }),
        ),
      });
      const workspace = { id: 'ws-1', webhookId: 'wh-abc' } as Workspace;
      const { dataSource, integrationRepo } = makeDataSource({ integration, workspace });
      const twilio = buildTwilioProvider({
        createTwiMLApp: jest
          .fn()
          .mockResolvedValue({ success: false, error: 'twilio down' }),
      });
      const svc = new TwilioVoiceProvisionerService(
        dataSource,
        encryption,
        twilio,
        cfg({ BASE_URL: 'https://sigcore.test' }),
      );

      await expect(svc.provisionVoice('int-1', 'ws-1')).rejects.toThrow(
        BadGatewayException,
      );
      // Row not saved — TwiML App failure leaves us with an in-memory API
      // Key that never gets persisted. Next call will create a fresh one.
      // Acceptable: an orphaned API Key on Twilio side (dead inventory)
      // is preferable to persisting half-provisioned state.
      expect(integrationRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('secret masking + logs', () => {
    it('error message thrown on API Key failure does not include the raw auth token', async () => {
      const encryption = makeEncryption();
      const integration = makeIntegration({
        credentialsEncrypted: encryption.encrypt(
          JSON.stringify({
            accountSid: 'AC',
            authToken: 'super_secret_auth_token_value',
          }),
        ),
      });
      const workspace = { id: 'ws-1', webhookId: 'wh-abc' } as Workspace;
      const { dataSource } = makeDataSource({ integration, workspace });
      const twilio = buildTwilioProvider({
        createApiKey: jest
          .fn()
          .mockResolvedValue({ success: false, error: 'auth failed' }),
      });
      const svc = new TwilioVoiceProvisionerService(
        dataSource,
        encryption,
        twilio,
        cfg({ BASE_URL: 'https://sigcore.test' }),
      );

      let thrown: Error | null = null;
      try {
        await svc.provisionVoice('int-1', 'ws-1');
      } catch (err) {
        thrown = err as Error;
      }
      expect(thrown).toBeTruthy();
      expect(thrown!.message).not.toContain('super_secret_auth_token_value');
    });
  });
});
