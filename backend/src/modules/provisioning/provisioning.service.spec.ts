/**
 * Wave-2 Task 6B.2 — ProvisioningService unit tests.
 *
 * Georgi's spec:
 *   - creates workspace + tenant + integration + identity
 *   - idempotent per (product, externalWorkspaceId)
 *   - never creates duplicates
 *   - rolls back cleanly on failure
 *   - contract-shaped response
 */

import type { DataSource } from 'typeorm';
import type { EncryptionService } from '../../common/services/encryption.service';
import { ProvisioningService } from './provisioning.service';
import { CommunicationIdentity } from '../../database/entities/communication-identity.entity';
import {
  CommunicationIntegration,
  IntegrationStatus,
  ProviderType,
} from '../../database/entities/communication-integration.entity';
import { Tenant } from '../../database/entities/tenant.entity';
import { Workspace } from '../../database/entities/workspace.entity';

type MockRepo = {
  findOne: jest.Mock;
  find: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
};

function repo(): MockRepo {
  return {
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn((v: any) => ({ ...v })),
    save: jest.fn(async (v: any) => ({ ...v, id: v.id ?? `gen-${Math.random().toString(36).slice(2, 10)}` })),
  };
}

function buildDataSource(rows: {
  identity?: MockRepo;
  integration?: MockRepo;
  workspace?: MockRepo;
  tenant?: MockRepo;
  txn?: { throwOnEntity?: 'workspace' | 'tenant' | 'integration' | 'identity'; throwError?: unknown };
} = {}) {
  const identity = rows.identity ?? repo();
  const integration = rows.integration ?? repo();
  const workspace = rows.workspace ?? repo();
  const tenant = rows.tenant ?? repo();

  const pick = (ctor: unknown): MockRepo => {
    if (ctor === CommunicationIdentity) return identity;
    if (ctor === CommunicationIntegration) return integration;
    if (ctor === Workspace) return workspace;
    if (ctor === Tenant) return tenant;
    throw new Error('unknown entity: ' + String(ctor));
  };

  // Optionally cause the save() of a specific entity to throw, so we can
  // assert rollback behavior. Applied inside the transaction manager's repos.
  const applyFailure = (mgrPick: (ctor: unknown) => MockRepo) => {
    if (!rows.txn?.throwOnEntity) return;
    const target = rows.txn.throwOnEntity;
    const map: Record<string, unknown> = {
      workspace: Workspace,
      tenant: Tenant,
      integration: CommunicationIntegration,
      identity: CommunicationIdentity,
    };
    const r = mgrPick(map[target]);
    r.save = jest.fn().mockRejectedValue(rows.txn.throwError ?? new Error('boom'));
  };

  const dataSource = {
    getRepository: jest.fn((ctor: unknown) => pick(ctor)),
    transaction: jest.fn(async (fn: (mgr: any) => Promise<any>) => {
      // A per-txn manager whose getRepository proxies to the SAME mock
      // instances (so assertions on saves work from the outside).
      const mgr = { getRepository: jest.fn((ctor: unknown) => pick(ctor)) };
      applyFailure(pick);
      return fn(mgr);
    }),
  } as unknown as DataSource;

  const encryption: EncryptionService = {
    encrypt: jest.fn((v: string) => `enc(${v})`),
    decrypt: jest.fn((v: string) => v.replace(/^enc\(/, '').replace(/\)$/, '')),
  } as unknown as EncryptionService;

  const service = new ProvisioningService(dataSource, encryption);
  return { service, dataSource, identity, integration, workspace, tenant, encryption };
}

const DTO = () => ({
  product: 'callio' as const,
  workspaceName: 'Acme Voice',
  externalWorkspaceId: 'callio-ws-123',
  metadata: { foo: 'bar' },
});

describe('ProvisioningService.provisionCommunicationIdentity', () => {
  describe('create path', () => {
    it('creates workspace + tenant + integration + identity in a single transaction', async () => {
      const { service, identity, integration, workspace, tenant, dataSource } =
        buildDataSource();
      identity.findOne.mockResolvedValue(null);

      const result = await service.provisionCommunicationIdentity(DTO());

      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(workspace.save).toHaveBeenCalledTimes(1);
      expect(tenant.save).toHaveBeenCalledTimes(1);
      expect(integration.save).toHaveBeenCalledTimes(1);
      expect(identity.save).toHaveBeenCalledTimes(1);

      // Response shape — communicationIdentityId is intentionally NOT
      // returned (kept internal per Task 6B.2 refinements). Consumers
      // rely on workspaceId + tenantId + integrations[].
      expect(result).toEqual({
        workspaceId: expect.any(String),
        tenantId: expect.any(String),
        integrations: [
          {
            provider: ProviderType.TWILIO,
            integrationId: expect.any(String),
            status: IntegrationStatus.ACTIVE,
          },
        ],
      });
    });

    it('workspace record uses the provided workspaceName + a random webhookId', async () => {
      const { service, identity, workspace } = buildDataSource();
      identity.findOne.mockResolvedValue(null);
      await service.provisionCommunicationIdentity(DTO());
      const saved = (workspace.save as jest.Mock).mock.calls[0][0];
      expect(saved.name).toBe('Acme Voice');
      expect(saved.webhookId).toMatch(/^[0-9a-f]{32}$/);
    });

    it('tenant external_id is scoped as `<product>-<externalWorkspaceId>` for human traceability', async () => {
      const { service, identity, tenant } = buildDataSource();
      identity.findOne.mockResolvedValue(null);
      await service.provisionCommunicationIdentity(DTO());
      const saved = (tenant.save as jest.Mock).mock.calls[0][0];
      expect(saved.externalId).toBe('callio-callio-ws-123');
      expect(saved.status).toBe('active');
      expect(saved.name).toBe('Acme Voice');
    });

    it('twilio integration is created with encrypted-empty credentials + status=active + provisioning-api metadata', async () => {
      const { service, identity, integration, encryption } = buildDataSource();
      identity.findOne.mockResolvedValue(null);
      await service.provisionCommunicationIdentity(DTO());
      const saved = (integration.save as jest.Mock).mock.calls[0][0];
      expect(saved.provider).toBe(ProviderType.TWILIO);
      expect(saved.status).toBe(IntegrationStatus.ACTIVE);
      expect(encryption.encrypt).toHaveBeenCalledWith('{}');
      expect(saved.credentialsEncrypted).toBe('enc({})');
      expect(saved.metadata.ensure.createdBy).toBe('provisioning-api');
      expect(saved.metadata.ensure.product).toBe('callio');
      expect(typeof saved.metadata.ensure.tenantId).toBe('string');
      expect(saved.metadata.ensure.tenantId.length).toBeGreaterThan(0);
    });

    it('identity row carries the caller-supplied metadata verbatim', async () => {
      const { service, identity } = buildDataSource();
      identity.findOne.mockResolvedValue(null);
      await service.provisionCommunicationIdentity({
        ...DTO(),
        metadata: { pilot: true, region: 'us-east' },
      });
      const saved = (identity.save as jest.Mock).mock.calls[0][0];
      expect(saved.metadata).toEqual({ pilot: true, region: 'us-east' });
    });

    it('identity metadata defaults to null when no metadata is supplied', async () => {
      const { service, identity } = buildDataSource();
      identity.findOne.mockResolvedValue(null);
      const dto = DTO();
      delete (dto as any).metadata;
      await service.provisionCommunicationIdentity(dto);
      const saved = (identity.save as jest.Mock).mock.calls[0][0];
      expect(saved.metadata).toBeNull();
    });
  });

  describe('idempotency', () => {
    it('fast-path: an existing identity is returned WITHOUT opening a transaction', async () => {
      const identity = repo();
      const integration = repo();
      identity.findOne.mockResolvedValue({
        id: 'id-existing',
        workspaceId: 'ws-existing',
        tenantId: 'tenant-existing',
        product: 'callio',
        externalWorkspaceId: 'callio-ws-123',
      });
      integration.find.mockResolvedValue([
        { id: 'int-existing', provider: 'twilio', status: 'active', workspaceId: 'ws-existing' },
      ]);

      const { service, dataSource } = buildDataSource({ identity, integration });
      const result = await service.provisionCommunicationIdentity(DTO());

      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(result.workspaceId).toBe('ws-existing');
      expect(result.tenantId).toBe('tenant-existing');
      expect(result.integrations).toEqual([
        { provider: 'twilio', integrationId: 'int-existing', status: 'active' },
      ]);
    });

    it('transactional re-check catches a race between fast-path miss and txn start', async () => {
      // First lookup (fast-path) → null. Second lookup (inside txn) → winner exists.
      const identity = repo();
      const integration = repo();
      identity.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'id-race-winner',
          workspaceId: 'ws-winner',
          tenantId: 'tenant-winner',
        });
      integration.find.mockResolvedValue([
        { id: 'int-winner', provider: 'twilio', status: 'active', workspaceId: 'ws-winner' },
      ]);

      const { service, workspace, tenant } = buildDataSource({ identity, integration });
      const result = await service.provisionCommunicationIdentity(DTO());

      // In-txn re-check surfaced the winner's workspace + tenant.
      expect(result.workspaceId).toBe('ws-winner');
      expect(result.tenantId).toBe('tenant-winner');
      // Race lost — we must NOT have inserted anything.
      expect(workspace.save).not.toHaveBeenCalled();
      expect(tenant.save).not.toHaveBeenCalled();
    });

    it('unique-violation (23505) inside txn resolves by re-reading the winning row', async () => {
      // Fast-path miss, in-txn re-check also misses, then identity.save rejects
      // with a Postgres 23505. Service should re-read and return the winning row.
      const identity = repo();
      const integration = repo();

      // Both pre-txn and in-txn lookups miss.
      identity.findOne
        .mockResolvedValueOnce(null) // fast path
        .mockResolvedValueOnce(null); // in-txn re-check

      // identity.save rejects with unique violation.
      identity.save = jest
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('duplicate key value'), { code: '23505' }));

      const { service } = buildDataSource({ identity, integration });

      // Post-race findExistingIdentity call — third invocation returns winner.
      identity.findOne.mockResolvedValueOnce({
        id: 'id-post-race',
        workspaceId: 'ws-post-race',
        tenantId: 'tenant-post-race',
      });
      integration.find.mockResolvedValueOnce([
        { id: 'int-post', provider: 'twilio', status: 'active', workspaceId: 'ws-post-race' },
      ]);

      const result = await service.provisionCommunicationIdentity(DTO());
      // Winner's identifiers, resolved via post-race re-read.
      expect(result.workspaceId).toBe('ws-post-race');
      expect(result.tenantId).toBe('tenant-post-race');
    });
  });

  describe('rollback', () => {
    it.each([
      ['workspace' as const],
      ['tenant' as const],
      ['integration' as const],
      ['identity' as const],
    ])('propagates errors thrown during %s save (transaction rolls back)', async (target) => {
      const identity = repo();
      identity.findOne.mockResolvedValue(null); // fast-path miss
      const { service } = buildDataSource({
        identity,
        txn: { throwOnEntity: target, throwError: new Error(`${target}-failed`) },
      });
      await expect(service.provisionCommunicationIdentity(DTO())).rejects.toThrow(
        `${target}-failed`,
      );
      // The DataSource.transaction API guarantees rollback on rejection — no
      // additional assertion needed at the service layer (that behavior lives
      // in TypeORM itself, exercised by the integration path).
    });

    it('a non-23505 DB error is re-thrown, not swallowed as a race', async () => {
      const identity = repo();
      identity.findOne.mockResolvedValue(null);
      identity.save = jest
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('connection lost'), { code: '08006' }));
      const { service } = buildDataSource({ identity });
      await expect(service.provisionCommunicationIdentity(DTO())).rejects.toThrow(
        'connection lost',
      );
    });
  });

  describe('input isolation', () => {
    it('two distinct (product, externalWorkspaceId) pairs open independent transactions', async () => {
      const { service, dataSource, identity } = buildDataSource();
      identity.findOne.mockResolvedValue(null);
      await service.provisionCommunicationIdentity({ ...DTO(), externalWorkspaceId: 'ws-a' });
      await service.provisionCommunicationIdentity({ ...DTO(), externalWorkspaceId: 'ws-b' });
      expect(dataSource.transaction).toHaveBeenCalledTimes(2);
    });
  });

  describe('response contract (golden shape)', () => {
    it('shape is exactly the documented API contract — no extra keys, no drift', async () => {
      const { service, identity } = buildDataSource();
      identity.findOne.mockResolvedValue(null);
      const result = await service.provisionCommunicationIdentity(DTO());
      // Top-level keys — no extras. communicationIdentityId is deliberately
      // absent from the public shape (Task 6B.2 refinement — kept internal).
      expect(Object.keys(result).sort()).toEqual(
        ['integrations', 'tenantId', 'workspaceId'].sort(),
      );
      // Per-integration keys — no extras.
      for (const int of result.integrations) {
        expect(Object.keys(int).sort()).toEqual(
          ['integrationId', 'provider', 'status'].sort(),
        );
      }
    });
  });
});
