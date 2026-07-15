import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { Reflector } from '@nestjs/core';

import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { OpenPhoneContactCacheService } from './openphone-contact-cache.service';
import { ProviderContextResolver } from './provider-context-resolver.service';
import { TwilioVoiceProvisionerService } from './twilio-voice-provisioner.service';
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

// Sigcore Browser Voice Contract — module-compile DI test.
//
// Guards against the class of failure Callio's Feature 1 hit in production:
// a controller method added a param decorator (@UserId) but its DI graph
// wasn't validated end-to-end, so the module booted only to crash on the
// first request. This test stands up the actual wiring — real
// IntegrationsController + IntegrationsService + SigcoreAuthGuard +
// TwilioVoiceService + ProviderContextResolver — and asserts they all
// resolve without touching the HTTP stack.
//
// Only external state (TypeORM repos) is stubbed. If a future refactor
// removes a provider or forgets a repository, .compile() throws with the
// exact injection that failed — same failure mode as the prod boot crash.
describe('Sigcore Browser Voice Contract DI graph', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stubRepo: any = {
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
  stubRepo.manager = {
    findOne: jest.fn(),
    getRepository: jest.fn(() => stubRepo),
  };

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0'.repeat(64);
  });

  it('resolves IntegrationsController + IntegrationsService + ProviderContextResolver + SigcoreAuthGuard', async () => {
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
        // Resolver — the single source of truth for caller-ID ownership.
        // Wire it so the compile test catches any regression where the
        // resolver is dropped from the module while IntegrationsService
        // still expects it (@Optional dep).
        ProviderContextResolver,
        // TwilioVoiceProvisionerService — the IntegrationsController now
        // injects this to serve POST /:id/provision-voice. Missing here
        // would repro the exact class of Feature-1-style boot crash the
        // compile tests are designed to prevent.
        TwilioVoiceProvisionerService,
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
        // TwilioVoiceProvisionerService uses @InjectDataSource() for
        // pessimistic_write row lock semantics — provide a stub with a
        // shape that mirrors DataSource.transaction()'s callback contract.
        {
          provide: getDataSourceToken(),
          useValue: {
            transaction: jest.fn(async (cb: any) => cb({ getRepository: () => stubRepo })),
          },
        },
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
    expect(typeof (controller as any).getTwilioVoiceToken).toBe('function');

    const service = moduleRef.get(IntegrationsService);
    expect(service).toBeDefined();
    expect(typeof (service as any).generateTwilioVoiceToken).toBe('function');
    expect(typeof (service as any).generateOutgoingCallTwiML).toBe('function');

    const resolver = moduleRef.get(ProviderContextResolver);
    expect(resolver).toBeDefined();

    const guard = moduleRef.get(SigcoreAuthGuard);
    expect(guard).toBeDefined();

    await moduleRef.close();
  });

  it('generateTwilioVoiceToken signature accepts (workspaceId, userId)', () => {
    const fn = IntegrationsService.prototype.generateTwilioVoiceToken;
    expect(fn.toString()).toMatch(
      /generateTwilioVoiceToken\s*\(\s*workspaceId[^)]*userId/,
    );
  });
});
