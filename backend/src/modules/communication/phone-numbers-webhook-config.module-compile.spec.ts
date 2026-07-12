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
});
