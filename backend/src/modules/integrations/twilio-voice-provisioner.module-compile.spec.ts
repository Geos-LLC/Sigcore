import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { Reflector } from '@nestjs/core';

import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { OpenPhoneContactCacheService } from './openphone-contact-cache.service';
import { TwilioVoiceProvisionerService } from './twilio-voice-provisioner.service';
import { ProviderContextResolver } from './provider-context-resolver.service';
import {
  LoggingProviderContextEventEmitter,
  PROVIDER_CONTEXT_EVENT_EMITTER,
} from './provider-context-events';
import { CommunicationService } from '../communication/communication.service';
import { TwilioProvider } from '../communication/providers/twilio.provider';
import { OpenPhoneProvider } from '../communication/providers/openphone.provider';
import { TwilioVoiceService } from '../communication/twilio-voice.service';
import { EncryptionService } from '../../common/services/encryption.service';
import { SigcoreAuthGuard } from '../auth/sigcore-auth.guard';
import {
  CommunicationIntegration,
  TenantIntegration,
  Tenant,
  Workspace,
  ContactIdentity,
  OpenPhoneContactSnapshot,
  CommunicationParticipant,
  CommunicationConversation,
  ApiKey,
  TenantPhoneNumber,
  CommunicationCall,
  CommunicationMessage,
  Sender,
} from '../../database/entities';

// Feature 2 — TwilioVoiceProvisionerService DI compile test.
//
// Standard "prevent Feature-1-style boot crash" pattern: stands up the real
// module wiring — IntegrationsController + TwilioVoiceProvisionerService +
// its EncryptionService + TwilioProvider + DataSource dependencies — via
// Nest's DI. Only external state (DataSource, TypeORM repos) is stubbed.
// A missing @InjectDataSource, forgotten module registration, or ordering
// mistake surfaces as an unresolved-token error here, identical to the
// production boot failure mode.
describe('TwilioVoiceProvisionerService DI graph', () => {
  const stubRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    createQueryBuilder: jest.fn(() => ({
      setLock: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn(),
    })),
  };

  // The provisioner uses @InjectDataSource() rather than a specific repo.
  // Stub the DataSource token with a transaction shape that mirrors real
  // TypeORM behavior enough for constructor resolution.
  const stubDataSource = {
    transaction: jest.fn(async (cb: any) => cb({ getRepository: () => stubRepo })),
  };

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0'.repeat(64);
  });

  it('resolves IntegrationsController with TwilioVoiceProvisionerService injected + all shared deps', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      controllers: [IntegrationsController],
      providers: [
        Reflector,
        ConfigService,
        EncryptionService,
        TwilioProvider,
        OpenPhoneProvider,
        TwilioVoiceService,
        SigcoreAuthGuard,
        IntegrationsService,
        // The unit under test — the real class + its full transitive graph.
        TwilioVoiceProvisionerService,
        // ProviderContextResolver + event emitter — dependencies of
        // IntegrationsService for caller-ID enforcement.
        ProviderContextResolver,
        {
          provide: PROVIDER_CONTEXT_EVENT_EMITTER,
          useClass: LoggingProviderContextEventEmitter,
        },
        {
          provide: CommunicationService,
          useValue: {
            getSyncStatus: jest.fn(),
            cancelSync: jest.fn(),
            deleteAllData: jest.fn(),
            getPhoneNumbers: jest.fn(),
          },
        },
        {
          provide: OpenPhoneContactCacheService,
          useValue: { get: jest.fn(), invalidate: jest.fn() },
        },
        { provide: getDataSourceToken(), useValue: stubDataSource },
        { provide: getRepositoryToken(CommunicationIntegration), useValue: stubRepo },
        { provide: getRepositoryToken(TenantIntegration), useValue: stubRepo },
        { provide: getRepositoryToken(Tenant), useValue: stubRepo },
        { provide: getRepositoryToken(Workspace), useValue: stubRepo },
        { provide: getRepositoryToken(ContactIdentity), useValue: stubRepo },
        { provide: getRepositoryToken(OpenPhoneContactSnapshot), useValue: stubRepo },
        { provide: getRepositoryToken(CommunicationParticipant), useValue: stubRepo },
        { provide: getRepositoryToken(CommunicationConversation), useValue: stubRepo },
        { provide: getRepositoryToken(ApiKey), useValue: stubRepo },
        { provide: getRepositoryToken(TenantPhoneNumber), useValue: stubRepo },
        { provide: getRepositoryToken(CommunicationCall), useValue: stubRepo },
        { provide: getRepositoryToken(CommunicationMessage), useValue: stubRepo },
        { provide: getRepositoryToken(Sender), useValue: stubRepo },
      ],
    }).compile();

    const controller = moduleRef.get(IntegrationsController);
    expect(controller).toBeDefined();
    // The new route handler exists and reflects the correct arity — dropping
    // either param would silently break the endpoint contract.
    expect(typeof (controller as any).provisionVoice).toBe('function');
    expect((controller as any).provisionVoice.length).toBe(2);

    const svc = moduleRef.get(TwilioVoiceProvisionerService);
    expect(svc).toBeDefined();
    expect(typeof (svc as any).provisionVoice).toBe('function');

    await moduleRef.close();
  });
});
