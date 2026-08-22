import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';

import { CallsV1Controller } from '../../modules/communication/calls.controller';
import { TwilioVoiceService } from '../../modules/communication/twilio-voice.service';
import { EncryptionService } from '../services/encryption.service';
import { CallbackForwarderService } from '../../modules/webhooks/callback-forwarder.service';
import { IntegrationResourceGuard } from './integration-resource.guard';
import { IntegrationResourceGuardService } from './integration-resource-guard.service';
import { Tenant } from '../../database/entities/tenant.entity';
import {
  ApiKey,
  CommunicationCall,
  CommunicationConversation,
  CommunicationIntegration,
  CommunicationProfile,
  ProfilePhoneAssignment,
  TenantPhoneNumber,
} from '../../database/entities';

// Wave-2 Task 3 module-compilation test.
//
// Callio's Task 5 first attempt crashed prod because gateway unit specs
// mocked their real dependencies and never exercised the actual Nest DI
// graph. The Wave-2 runbook now requires "actual Nest module-compilation
// test for the modified module graph" for every scaffolding PR that touches
// providers/imports/exports/@Inject sites.
//
// This test declares the exact Task 3 provider block from
// `communication.module.ts` (guard service + guard + controller + service
// + supporting repos) and calls `.compile()`. No mock is supplied for any
// Task 3 class — only external infrastructure (TypeORM repositories +
// ConfigService) is stubbed.
//
// If any Task 3 constructor param cannot resolve, `.compile()` throws — the
// same failure mode that would appear at Sigcore boot.
describe('Task 3 DI graph (real bootstrap)', () => {
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

  it('resolves Task 3 DI graph with only infrastructure overrides', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      controllers: [CallsV1Controller],
      providers: [
        Reflector,
        EncryptionService,
        TwilioVoiceService,
        IntegrationResourceGuardService,
        IntegrationResourceGuard,
        ConfigService,
        // Task 6B.5C — CallsV1Controller now takes CallbackForwarderService.
        CallbackForwarderService,
        // Phase C — CallsV1Controller.dial takes DialIdempotencyService.
        require('../../modules/communication/dial-idempotency.service').DialIdempotencyService,
        // Infrastructure overrides only — external state Nest can't
        // reach in a test process.
        { provide: getRepositoryToken(Tenant), useValue: stubRepo },
        {
          provide: getRepositoryToken(CommunicationIntegration),
          useValue: stubRepo,
        },
        { provide: getRepositoryToken(CommunicationCall), useValue: stubRepo },
        { provide: getRepositoryToken(TenantPhoneNumber), useValue: stubRepo },
        // 2026-08-22 (G-6 CSAP) — CallsV1Controller also injects
        // Conversation / ProfilePhoneAssignment / CommunicationProfile
        // repos as of Task 5c. Stub each so this compile-time DI check
        // stays green after the controller's constructor grew.
        { provide: getRepositoryToken(CommunicationConversation), useValue: stubRepo },
        { provide: getRepositoryToken(ProfilePhoneAssignment), useValue: stubRepo },
        { provide: getRepositoryToken(CommunicationProfile), useValue: stubRepo },
        // SigcoreAuthGuard (applied to CallsV1Controller via @UseGuards)
        // resolves this repo. Stub because Nest needs to construct the
        // guard when it builds the controller's guard chain.
        { provide: getRepositoryToken(ApiKey), useValue: stubRepo },
      ],
    }).compile();

    // Guard service resolves with its four repository deps.
    const svc = moduleRef.get(IntegrationResourceGuardService);
    expect(svc).toBeDefined();

    // Guard resolves via Reflector + service.
    const guard = moduleRef.get(IntegrationResourceGuard);
    expect(guard).toBeDefined();

    // Controller resolves via TwilioVoiceService.
    const controller = moduleRef.get(CallsV1Controller);
    expect(controller).toBeDefined();

    // TwilioVoiceService resolves via ConfigService + EncryptionService.
    const svc2 = moduleRef.get(TwilioVoiceService);
    expect(svc2).toBeDefined();

    await moduleRef.close();
  });
});
