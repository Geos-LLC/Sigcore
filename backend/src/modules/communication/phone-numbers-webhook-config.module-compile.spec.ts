import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';

import { PhoneNumbersWebhookConfigController } from './phone-numbers.controller';
import { PhoneNumbersService } from './phone-numbers.service';
import { TwilioProvider } from './providers/twilio.provider';
import { EncryptionService } from '../../common/services/encryption.service';
import { IntegrationResourceGuard } from '../../common/guards/integration-resource.guard';
import { IntegrationResourceGuardService } from '../../common/guards/integration-resource-guard.service';
import { INTEGRATION_RESOURCE_KEY } from '../../common/guards/use-integration-resource-guard.decorator';
import { SigcoreAuthGuard } from '../auth/sigcore-auth.guard';
import { Tenant } from '../../database/entities/tenant.entity';
import {
  ApiKey,
  CommunicationCall,
  CommunicationIntegration,
  Sender,
  TenantPhoneNumber,
} from '../../database/entities';

// Wave-2 Task 4 (PR-1) module-compilation test.
//
// Same rationale as `integration-resource-guard.module-compile.spec.ts`:
// unit specs mock their real deps, so the actual Nest DI graph never gets
// exercised. This test declares the exact PR-1 provider block from
// `communication.module.ts` (PhoneNumbersWebhookConfigController +
// PhoneNumbersService + guard chain + supporting repos) and calls
// `.compile()`. No PR-1 class is mocked — only external infra (TypeORM
// repositories + ConfigService) is stubbed.
//
// If any constructor param cannot resolve — e.g. the new PhoneNumbers-
// WebhookConfigController is added to the module without wiring its
// dependencies, or PhoneNumbersService's added TenantPhoneNumber repo
// isn't in the forFeature list — `.compile()` throws, which is the exact
// failure mode that would surface at Sigcore boot.
describe('PR-1 phone-numbers webhook-config DI graph (real bootstrap)', () => {
  const stubRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    createQueryBuilder: jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn(),
      getMany: jest.fn(),
    })),
  };

  beforeAll(() => {
    process.env.ENCRYPTION_KEY =
      process.env.ENCRYPTION_KEY || '0'.repeat(64);
  });

  it('resolves the PR-1 DI graph with only infrastructure overrides', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      controllers: [PhoneNumbersWebhookConfigController],
      providers: [
        Reflector,
        ConfigService,
        EncryptionService,
        TwilioProvider,
        PhoneNumbersService,
        IntegrationResourceGuardService,
        IntegrationResourceGuard,
        // TypeORM repository stubs — external state.
        {
          provide: getRepositoryToken(CommunicationIntegration),
          useValue: stubRepo,
        },
        { provide: getRepositoryToken(Sender), useValue: stubRepo },
        { provide: getRepositoryToken(TenantPhoneNumber), useValue: stubRepo },
        { provide: getRepositoryToken(Tenant), useValue: stubRepo },
        { provide: getRepositoryToken(CommunicationCall), useValue: stubRepo },
        // SigcoreAuthGuard is applied to the controller via @UseGuards and
        // reads ApiKey from repo.
        { provide: getRepositoryToken(ApiKey), useValue: stubRepo },
      ],
    }).compile();

    const controller = moduleRef.get(PhoneNumbersWebhookConfigController);
    expect(controller).toBeDefined();

    const service = moduleRef.get(PhoneNumbersService);
    expect(service).toBeDefined();

    // Verify the new provider method exists on TwilioProvider (guards against
    // accidental removal of the method that the service calls).
    const twilio = moduleRef.get(TwilioProvider);
    expect(typeof (twilio as any).updateNumberWebhooks).toBe('function');

    // The IntegrationResourceGuard (per-route decorator) resolves.
    const guard = moduleRef.get(IntegrationResourceGuard);
    expect(guard).toBeDefined();

    await moduleRef.close();
  });

  // Ownership-chain assertions per Georgi's PR-1 approval memo. These verify
  // the guards are wired to the route so credential resolution flows through
  // the authoritative chain (TPN → tenant/workspace → integration).
  //
  // The actual guard *behavior* (cross-workspace rejection, cross-tenant
  // rejection, provider-mismatch rejection) is covered by
  // integration-resource-guard.service.spec.ts — most notably:
  //   * "rejects when tpn not found (check=4)" at spec line 204 — covers
  //     both cross-workspace and cross-tenant because the guard's TPN lookup
  //     is scoped `{id: tpnId, workspaceId, tenantId}`;
  //   * "rejects when tpn provider does not match integration provider
  //     (check=4)" at spec line 220 — the exact provider-mismatch case.
  // This spec confirms those enforcements apply to the new endpoint, not
  // just to /v1/calls/*.
  describe('ownership-chain wiring on POST /v1/phone-numbers/:tpnId/webhook-config', () => {
    const handler = (
      PhoneNumbersWebhookConfigController.prototype as unknown as {
        configureWebhooks: unknown;
      }
    ).configureWebhooks;

    it('@UseIntegrationResourceGuard("tpnId") is applied to the route handler', () => {
      // The decorator sets INTEGRATION_RESOURCE_KEY metadata to 'tpnId'.
      // Missing decorator would mean the guard never fires and cross-workspace
      // calls could reach the service; the assertion below fails loudly if the
      // decorator is dropped by a future refactor.
      const kind = Reflect.getMetadata(INTEGRATION_RESOURCE_KEY, handler as any);
      expect(kind).toBe('tpnId');

      // The decorator also attaches IntegrationResourceGuard via @UseGuards().
      // Nest stores that under the '__guards__' metadata key.
      const guards: unknown[] =
        Reflect.getMetadata('__guards__', handler as any) ?? [];
      expect(guards).toContain(IntegrationResourceGuard);
    });

    it('@UseGuards(SigcoreAuthGuard) is applied at the controller class level', () => {
      // Controller-level guards run first and populate request.workspaceId /
      // request.tenantId. Without this guard, IntegrationResourceGuard would
      // have no auth context to compare against.
      const guards: unknown[] =
        Reflect.getMetadata('__guards__', PhoneNumbersWebhookConfigController) ??
        [];
      expect(guards).toContain(SigcoreAuthGuard);
    });
  });
});
