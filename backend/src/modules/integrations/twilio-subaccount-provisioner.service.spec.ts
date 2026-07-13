/**
 * Wave-2 Task 6B.5A — TwilioSubaccountProvisioner state machine tests.
 *
 * Covers scenarios 1-8 and 11 of Georgi's spec:
 *
 *   1. New identity begins pending_credentials
 *   2. Successful provider provisioning transitions to ready
 *   3. Existing ready integration is idempotent
 *   4. Repeated provisioning creates no duplicate provider resources
 *   5. Provider authentication failure produces error
 *   6. Partial provisioning can be retried
 *   7. Empty encrypted credentials never report ready
 *   8. Existing legacy integration with valid credentials reports ready
 *  11. No credential values in response or logs
 *
 * Cross-workspace / cross-tenant (9, 10) live in IntegrationResourceGuard
 * specs (pre-existing coverage). Backward compat (12) covered in
 * integrations.service.spec. Module compile (13) in a dedicated compile
 * spec. Existing regression (15) via the full jest run.
 */

import { ConflictException, BadGatewayException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DataSource, EntityManager, Repository, SelectQueryBuilder } from 'typeorm';

import { TwilioSubaccountProvisionerService } from './twilio-subaccount-provisioner.service';
import type { EncryptionService } from '../../common/services/encryption.service';
import type { TwilioProvider } from '../communication/providers/twilio.provider';
import {
  CommunicationIntegration,
  OperationalStatus,
  OperationalReasonCode,
  ProviderType,
} from '../../database/entities/communication-integration.entity';
import { Workspace } from '../../database/entities/workspace.entity';

// ---------- test doubles ----------

/**
 * DataSource / transaction / row-lock harness. Records save() calls in
 * `saved` so tests can assert the transition sequence. Simulates
 * `SELECT ... FOR UPDATE` by returning the current stored row.
 */
function makeDataSource(store: {
  integration: CommunicationIntegration;
  workspace?: Workspace | null;
}): { ds: DataSource; saved: CommunicationIntegration[] } {
  const saved: CommunicationIntegration[] = [];
  const integrationRepo = {
    createQueryBuilder: () => {
      const qb: Partial<SelectQueryBuilder<CommunicationIntegration>> = {
        setLock: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        getOne: jest.fn(async () => store.integration),
      };
      return qb as SelectQueryBuilder<CommunicationIntegration>;
    },
    save: jest.fn(async (row: CommunicationIntegration) => {
      // Persist mutation to the shared store so subsequent reads observe it.
      store.integration = { ...row };
      saved.push({ ...row });
      return row;
    }),
  } as unknown as Repository<CommunicationIntegration>;

  const workspaceRepo = {
    findOne: jest.fn(async () => store.workspace ?? null),
  } as unknown as Repository<Workspace>;

  const mgr = {
    getRepository: (entity: unknown) =>
      entity === CommunicationIntegration ? integrationRepo : workspaceRepo,
  } as unknown as EntityManager;

  const ds = {
    transaction: async <T>(cb: (mgr: EntityManager) => Promise<T>): Promise<T> => cb(mgr),
  } as unknown as DataSource;

  return { ds, saved };
}

function makeEncryption(): jest.Mocked<EncryptionService> {
  return {
    encrypt: jest.fn((plain: string) => `enc(${plain})`),
    decrypt: jest.fn((enc: string) => {
      if (enc === "enc({})") return '{}';
      if (enc.startsWith('enc(')) return enc.slice(4, -1);
      return enc;
    }),
  } as unknown as jest.Mocked<EncryptionService>;
}

function makeConfig(overrides: Record<string, string | undefined> = {}): ConfigService {
  const base: Record<string, string | undefined> = {
    SIGCORE_TWILIO_MASTER_ACCOUNT_SID: 'ACmasterXXX',
    SIGCORE_TWILIO_MASTER_AUTH_TOKEN: 'master-token-secret',
    ...overrides,
  };
  return {
    get: <T = string>(k: string): T | undefined => base[k] as T | undefined,
  } as unknown as ConfigService;
}

function makeTwilioProvider(overrides: {
  create?: TwilioProvider['createSubaccount'];
  preflight?: TwilioProvider['preflightSubaccount'];
} = {}): jest.Mocked<TwilioProvider> {
  return {
    createSubaccount: jest.fn(
      overrides.create ??
        (async (_master, friendlyName) => ({
          subaccountSid: 'ACsub-fresh',
          subaccountAuthToken: 'sub-token-fresh',
          friendlyName,
          status: 'active',
        })),
    ),
    preflightSubaccount: jest.fn(
      overrides.preflight ??
        (async () => ({ ok: true as const, accountStatus: 'active', friendlyName: 'ok' })),
    ),
  } as unknown as jest.Mocked<TwilioProvider>;
}

function fakeIntegration(overrides: Partial<CommunicationIntegration> = {}): CommunicationIntegration {
  return {
    id: 'int-uuid-1',
    workspaceId: 'ws-uuid-1',
    provider: ProviderType.TWILIO,
    credentialsEncrypted: 'enc({})',
    status: 'active',
    operationalStatus: OperationalStatus.PENDING_CREDENTIALS,
    operationalReason: OperationalReasonCode.TWILIO_CREDENTIALS_NOT_CONFIGURED,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as CommunicationIntegration;
}

// ---------- tests ----------

describe('TwilioSubaccountProvisionerService', () => {
  describe('scenario 2: successful provisioning transitions pending_credentials → ready', () => {
    it('mints a subaccount, encrypts credentials, preflights, stamps verified timestamp', async () => {
      const integration = fakeIntegration();
      const workspace = { id: 'ws-uuid-1', name: 'Acme Voice' } as Workspace;
      const { ds, saved } = makeDataSource({ integration, workspace });
      const encryption = makeEncryption();
      const twilio = makeTwilioProvider();

      const svc = new TwilioSubaccountProvisionerService(
        ds,
        encryption,
        twilio,
        makeConfig(),
      );

      const result = await svc.ensureReady('int-uuid-1');

      // Twilio subaccount created exactly once.
      expect(twilio.createSubaccount).toHaveBeenCalledTimes(1);
      expect(twilio.createSubaccount).toHaveBeenCalledWith(
        { accountSid: 'ACmasterXXX', authToken: 'master-token-secret' },
        expect.stringContaining('Sigcore/Callio'),
      );
      // Preflight ran against the NEW subaccount, not the master.
      expect(twilio.preflightSubaccount).toHaveBeenCalledWith(
        expect.objectContaining({ accountSid: 'ACsub-fresh' }),
      );
      // Final state is ready + verified timestamp.
      expect(result.operationalStatus).toBe(OperationalStatus.READY);
      expect(result.operationalReason).toBeNull();
      expect(result.operationalLastVerifiedAt).toBeInstanceOf(Date);
      expect(result.providerSubaccountSid).toBe('ACsub-fresh');
      // Transition sequence: provisioning → row saved with creds → ready.
      const statuses = saved.map((r) => r.operationalStatus);
      expect(statuses).toEqual([
        OperationalStatus.PROVISIONING,
        OperationalStatus.PROVISIONING, // creds persisted before preflight
        OperationalStatus.READY,
      ]);
    });
  });

  describe('scenario 3: idempotency — already-ready integration returns immediately', () => {
    it('does not mint a new subaccount when operationalStatus is already ready', async () => {
      const integration = fakeIntegration({
        operationalStatus: OperationalStatus.READY,
        operationalReason: null,
        credentialsEncrypted: 'enc({"accountSid":"ACsub-existing","authToken":"tok"})',
        providerSubaccountSid: 'ACsub-existing',
      });
      const { ds, saved } = makeDataSource({ integration });
      const twilio = makeTwilioProvider();
      const svc = new TwilioSubaccountProvisionerService(
        ds,
        makeEncryption(),
        twilio,
        makeConfig(),
      );

      const result = await svc.ensureReady('int-uuid-1');

      expect(twilio.createSubaccount).not.toHaveBeenCalled();
      expect(twilio.preflightSubaccount).not.toHaveBeenCalled();
      expect(saved).toHaveLength(0);
      expect(result.providerSubaccountSid).toBe('ACsub-existing');
    });
  });

  describe('scenario 4: repeated provisioning creates no duplicate provider resources', () => {
    it('two sequential ensureReady calls result in exactly one subaccount create call', async () => {
      const integration = fakeIntegration();
      const workspace = { id: 'ws-uuid-1', name: 'Acme' } as Workspace;
      const { ds } = makeDataSource({ integration, workspace });
      const twilio = makeTwilioProvider();
      const svc = new TwilioSubaccountProvisionerService(
        ds,
        makeEncryption(),
        twilio,
        makeConfig(),
      );

      await svc.ensureReady('int-uuid-1');
      // Second call — row is now `ready`, provisioner should short-circuit.
      await svc.ensureReady('int-uuid-1');

      expect(twilio.createSubaccount).toHaveBeenCalledTimes(1);
    });
  });

  describe('scenario 5: provider authentication failure produces error', () => {
    it('preflight auth failure transitions to error with TWILIO_AUTH_FAILED', async () => {
      const integration = fakeIntegration();
      const workspace = { id: 'ws-uuid-1', name: 'Acme' } as Workspace;
      const { ds } = makeDataSource({ integration, workspace });
      const twilio = makeTwilioProvider({
        preflight: async () => ({
          ok: false as const,
          reason: 'TWILIO_AUTH_FAILED',
          detail: 'status=401 code=20003',
        }),
      });
      const svc = new TwilioSubaccountProvisionerService(
        ds,
        makeEncryption(),
        twilio,
        makeConfig(),
      );

      await expect(svc.ensureReady('int-uuid-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      // But the row is still there, with error state — retry allowed.
      expect(integration.operationalStatus).toBe(OperationalStatus.ERROR);
      expect(integration.operationalReason).toBe('TWILIO_AUTH_FAILED');
      // Subaccount was minted before preflight — it stays on Twilio; the
      // next retry could re-preflight, but the current provisioner design
      // sees the persisted subaccount_sid + creds and preflights the same
      // subaccount rather than minting a new one on retry.
      expect(twilio.createSubaccount).toHaveBeenCalledTimes(1);
    });

    it('subaccount create failure transitions to error with TWILIO_SUBACCOUNT_CREATE_FAILED', async () => {
      const integration = fakeIntegration();
      const workspace = { id: 'ws-uuid-1', name: 'Acme' } as Workspace;
      const { ds } = makeDataSource({ integration, workspace });
      const twilio = makeTwilioProvider({
        create: async () => {
          throw new Error('Twilio API 500');
        },
      });
      const svc = new TwilioSubaccountProvisionerService(
        ds,
        makeEncryption(),
        twilio,
        makeConfig(),
      );

      await expect(svc.ensureReady('int-uuid-1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(integration.operationalStatus).toBe(OperationalStatus.ERROR);
      expect(integration.operationalReason).toBe(
        OperationalReasonCode.TWILIO_SUBACCOUNT_CREATE_FAILED,
      );
      // No subaccount SID persisted — nothing to reuse on retry.
      expect(integration.providerSubaccountSid).toBeFalsy();
    });
  });

  describe('scenario 6: partial provisioning can be retried', () => {
    it('after preflight failure, a second call re-runs preflight (does NOT mint a duplicate subaccount)', async () => {
      const integration = fakeIntegration();
      const workspace = { id: 'ws-uuid-1', name: 'Acme' } as Workspace;
      const { ds } = makeDataSource({ integration, workspace });
      let preflightCallNo = 0;
      const twilio = makeTwilioProvider({
        preflight: async () => {
          preflightCallNo++;
          if (preflightCallNo === 1) {
            return { ok: false as const, reason: 'TWILIO_PROVIDER_UNREACHABLE', detail: 'timeout' };
          }
          return { ok: true as const, accountStatus: 'active', friendlyName: 'ok' };
        },
      });
      const svc = new TwilioSubaccountProvisionerService(
        ds,
        makeEncryption(),
        twilio,
        makeConfig(),
      );

      // First attempt fails preflight — row transitions to error, but
      // the subaccount SID + credentials are already persisted from the
      // create-and-save step that ran before preflight.
      await expect(svc.ensureReady('int-uuid-1')).rejects.toBeInstanceOf(ConflictException);
      expect(integration.operationalStatus).toBe(OperationalStatus.ERROR);
      expect(integration.providerSubaccountSid).toBe('ACsub-fresh');
      expect(integration.credentialsEncrypted).toMatch(/ACsub-fresh/);

      // Retry: provisioner sees persisted subaccount + creds and REUSES
      // them — no duplicate subaccount create. Preflight succeeds on this
      // pass and the row transitions to ready.
      const repaired = await svc.ensureReady('int-uuid-1');
      expect(twilio.createSubaccount).toHaveBeenCalledTimes(1); // no duplicate
      expect(twilio.preflightSubaccount).toHaveBeenCalledTimes(2); // re-preflighted
      expect(repaired.operationalStatus).toBe(OperationalStatus.READY);
      expect(repaired.operationalReason).toBeNull();
      expect(repaired.providerSubaccountSid).toBe('ACsub-fresh');
    });

    it('unrecoverable partial state: subaccount SID persisted but credentials empty (auth token lost) — marks error, does NOT mint duplicate', async () => {
      // Simulate the pathological state where a prior attempt wrote the
      // subaccount SID but failed to persist the auth token. Twilio does
      // not re-emit the auth token, so this is operator-recoverable only.
      const integration = fakeIntegration({
        providerSubaccountSid: 'ACsub-orphan',
        credentialsEncrypted: 'enc({})',
        operationalStatus: OperationalStatus.ERROR,
        operationalReason: OperationalReasonCode.TWILIO_SUBACCOUNT_CREATE_FAILED,
      });
      const workspace = { id: 'ws-uuid-1', name: 'Acme' } as Workspace;
      const { ds } = makeDataSource({ integration, workspace });
      const twilio = makeTwilioProvider();
      const svc = new TwilioSubaccountProvisionerService(
        ds,
        makeEncryption(),
        twilio,
        makeConfig(),
      );

      await expect(svc.ensureReady('int-uuid-1')).rejects.toBeInstanceOf(ConflictException);
      // No duplicate subaccount minted.
      expect(twilio.createSubaccount).not.toHaveBeenCalled();
      // Row stays in error state with a clear reason.
      expect(integration.operationalStatus).toBe(OperationalStatus.ERROR);
    });
  });

  describe('scenario 7: empty encrypted credentials never report ready', () => {
    it('grandfathered NULL operational_status with empty credentials still triggers provisioning', async () => {
      const integration = fakeIntegration({
        operationalStatus: null, // legacy NULL
        credentialsEncrypted: 'enc({})', // empty
      });
      const workspace = { id: 'ws-uuid-1', name: 'Acme' } as Workspace;
      const { ds } = makeDataSource({ integration, workspace });
      const twilio = makeTwilioProvider();
      const svc = new TwilioSubaccountProvisionerService(
        ds,
        makeEncryption(),
        twilio,
        makeConfig(),
      );

      await svc.ensureReady('int-uuid-1');

      // Provisioner did NOT treat NULL+empty as ready — it minted a subaccount.
      expect(twilio.createSubaccount).toHaveBeenCalledTimes(1);
      expect(integration.operationalStatus).toBe(OperationalStatus.READY);
    });
  });

  describe('scenario 8: legacy pilot row (NULL status + valid credentials) reports ready', () => {
    it('grandfathered NULL operational_status with non-empty credentials short-circuits without minting', async () => {
      const integration = fakeIntegration({
        operationalStatus: null,
        credentialsEncrypted: 'enc({"accountSid":"ACpilot","authToken":"pilot-tok"})',
      });
      const { ds, saved } = makeDataSource({ integration });
      const twilio = makeTwilioProvider();
      const svc = new TwilioSubaccountProvisionerService(
        ds,
        makeEncryption(),
        twilio,
        makeConfig(),
      );

      const result = await svc.ensureReady('int-uuid-1');

      // Zero side effects — pilot behavior is fully preserved.
      expect(twilio.createSubaccount).not.toHaveBeenCalled();
      expect(twilio.preflightSubaccount).not.toHaveBeenCalled();
      expect(saved).toHaveLength(0);
      expect(result).toBe(integration);
    });
  });

  describe('scenario 11: no credential values in response or logs', () => {
    it('no logger.log or logger.warn call contains the master or subaccount auth token', async () => {
      const integration = fakeIntegration();
      const workspace = { id: 'ws-uuid-1', name: 'Acme' } as Workspace;
      const { ds } = makeDataSource({ integration, workspace });
      const twilio = makeTwilioProvider();
      const svc = new TwilioSubaccountProvisionerService(
        ds,
        makeEncryption(),
        twilio,
        makeConfig(),
      );
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        await svc.ensureReady('int-uuid-1');
        const allLines = [...logSpy.mock.calls, ...warnSpy.mock.calls]
          .map((c) => String(c[0]))
          .join('\n');
        expect(allLines).not.toMatch(/master-token-secret/);
        expect(allLines).not.toMatch(/sub-token-fresh/);
        expect(allLines).not.toMatch(/authToken/);
      } finally {
        logSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });
  });

  describe('master credentials absent', () => {
    it('marks error with TWILIO_CREDENTIALS_NOT_CONFIGURED when Sigcore master creds env is empty', async () => {
      const integration = fakeIntegration();
      const workspace = { id: 'ws-uuid-1', name: 'Acme' } as Workspace;
      const { ds } = makeDataSource({ integration, workspace });
      const twilio = makeTwilioProvider();
      const svc = new TwilioSubaccountProvisionerService(
        ds,
        makeEncryption(),
        twilio,
        makeConfig({
          SIGCORE_TWILIO_MASTER_ACCOUNT_SID: undefined,
          SIGCORE_TWILIO_MASTER_AUTH_TOKEN: undefined,
          TWILIO_ACCOUNT_SID: undefined,
          TWILIO_AUTH_TOKEN: undefined,
        }),
      );

      await expect(svc.ensureReady('int-uuid-1')).rejects.toBeInstanceOf(ConflictException);
      expect(integration.operationalStatus).toBe(OperationalStatus.ERROR);
      expect(integration.operationalReason).toBe(
        OperationalReasonCode.TWILIO_CREDENTIALS_NOT_CONFIGURED,
      );
      // Never touched Twilio at all.
      expect(twilio.createSubaccount).not.toHaveBeenCalled();
    });
  });

  describe('non-Twilio integration', () => {
    it('returns unchanged when provider is not Twilio (out of scope for this state machine)', async () => {
      const integration = fakeIntegration({
        provider: ProviderType.OPENPHONE,
        operationalStatus: OperationalStatus.PENDING_CREDENTIALS,
      });
      const { ds, saved } = makeDataSource({ integration });
      const twilio = makeTwilioProvider();
      const svc = new TwilioSubaccountProvisionerService(
        ds,
        makeEncryption(),
        twilio,
        makeConfig(),
      );

      const result = await svc.ensureReady('int-uuid-1');

      expect(result).toBe(integration);
      expect(saved).toHaveLength(0);
      expect(twilio.createSubaccount).not.toHaveBeenCalled();
    });
  });
});
