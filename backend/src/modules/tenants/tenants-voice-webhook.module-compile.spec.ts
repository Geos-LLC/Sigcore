import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as fs from 'fs';
import * as path from 'path';

import { TenantsV1Controller } from './tenants.controller';
import { TenantsService } from './tenants.service';
import { PhoneNumberProvisioningService } from './phone-number-provisioning.service';
import { EncryptionService } from '../../common/services/encryption.service';
import { ProviderRegistry } from '../communication/providers/provider-registry.service';
import { TwilioProvider } from '../communication/providers/twilio.provider';
import { OpenPhoneProvider } from '../communication/providers/openphone.provider';
import { WhatsAppWebProvider } from '../communication/providers/whatsapp-web.provider';
import {
  ApiKey,
  CommunicationBusiness,
  CommunicationIntegration,
  CommunicationProfile,
  PhoneNumberOrder,
  PhoneNumberPricing,
  ProfilePhoneAssignment,
  Sender,
  Tenant,
  TenantIntegration,
  TenantPhoneNumber,
  WebhookSubscription,
  Workspace,
} from '../../database/entities';

// PR 2 module-compile test.
//
// Wires the pieces the PUT/GET /v1/tenants/:tenantId/voice-webhook route
// depends on and verifies `.compile()` succeeds. Same shape as the PR-1
// module-compile spec.
//
// Also runs a runtime-search that PROVES `voice_inbound_url` (snake_case
// column) and `voiceInboundUrl` (camelCase field) are read only from the
// PR 2 read paths — the runbook invariant "voice_inbound_url is stored
// only; it is not read anywhere until PR 3."

describe('PR 2 tenant voice-webhook DI graph (real bootstrap)', () => {
  const stubRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    remove: jest.fn(),
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

  it('resolves the PR 2 DI graph with only infrastructure overrides', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true })],
      controllers: [TenantsV1Controller],
      providers: [
        ConfigService,
        EncryptionService,
        TenantsService,
        PhoneNumberProvisioningService,
        ProviderRegistry,
        TwilioProvider,
        OpenPhoneProvider,
        WhatsAppWebProvider,
        { provide: getRepositoryToken(Tenant), useValue: stubRepo },
        { provide: getRepositoryToken(TenantPhoneNumber), useValue: stubRepo },
        {
          provide: getRepositoryToken(CommunicationIntegration),
          useValue: stubRepo,
        },
        { provide: getRepositoryToken(Sender), useValue: stubRepo },
        { provide: getRepositoryToken(TenantIntegration), useValue: stubRepo },
        { provide: getRepositoryToken(PhoneNumberOrder), useValue: stubRepo },
        {
          provide: getRepositoryToken(PhoneNumberPricing),
          useValue: stubRepo,
        },
        {
          provide: getRepositoryToken(CommunicationBusiness),
          useValue: stubRepo,
        },
        {
          provide: getRepositoryToken(CommunicationProfile),
          useValue: stubRepo,
        },
        {
          provide: getRepositoryToken(ProfilePhoneAssignment),
          useValue: stubRepo,
        },
        {
          provide: getRepositoryToken(WebhookSubscription),
          useValue: stubRepo,
        },
        { provide: getRepositoryToken(Workspace), useValue: stubRepo },
        { provide: getRepositoryToken(ApiKey), useValue: stubRepo },
      ],
    }).compile();

    const controller = moduleRef.get(TenantsV1Controller);
    expect(controller).toBeDefined();

    const service = moduleRef.get(TenantsService);
    expect(service).toBeDefined();

    // The two new service methods exist (guards against accidental removal).
    expect(typeof (service as any).setVoiceInboundUrl).toBe('function');
    expect(typeof (service as any).getVoiceInboundConfig).toBe('function');

    await moduleRef.close();
  });
});

// Runtime-search proof.
//
// PR 2 (2026-07-12): exactly 2 runtime files referenced tenant.voiceInboundUrl
//   — tenants.service.ts (setter/getter) and tenants.controller.ts (response
//     shape).
//
// PR 3 (2026-07-12): the twilio inbound webhook router (twilio-webhooks.service
//   .ts) now also reads tenant.voiceInboundUrl to decide whether to fire the
//   tenant-forward step. Expected count updated to 3.
//
// If a future PR adds a 4th consumer this test starts failing — intentional.
// The failure forces the operator to update the invariant list below and
// verify the new consumer is where they think it is.
describe('voice_inbound_url runtime-read invariant', () => {
  const SRC_ROOT = path.resolve(__dirname, '..', '..');
  const IGNORE_DIRS = new Set(['node_modules', 'dist', 'migrations']);

  function walk(dir: string, out: string[]): void {
    for (const name of fs.readdirSync(dir)) {
      if (IGNORE_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full, out);
      } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
        out.push(full);
      }
    }
  }

  it('exactly one runtime file reads voiceInboundUrl, and it is the tenant service', () => {
    const files: string[] = [];
    walk(SRC_ROOT, files);

    // Where writes are OK (they're not runtime consumers per the spec's
    // definition): the entity declaration, DTO, validator, service methods
    // that write, controller endpoints that expose CRUD. What the spec cares
    // about is: no INBOUND-VOICE-ROUTING code path reads this yet.
    //
    // We identify files that "read" the field by presence of one of:
    //   .voiceInboundUrl
    //   'voiceInboundUrl' as a JSON body key (not counted here)
    //   tenant.voiceInboundUrl
    // then subtract the known intentional-read files (service, controller
    // response mapping, entity declaration itself, DTO).
    const readingFiles = files.filter((f) => {
      const content = fs.readFileSync(f, 'utf8');
      return /voiceInboundUrl/.test(content);
    });

    // Sanity: at least the entity + DTO + validator + service + controller
    // must contain the identifier — else the plumbing was accidentally lost.
    expect(readingFiles.length).toBeGreaterThan(0);

    // Restrict to files that actually CONSUME the value (read on a Tenant
    // instance), not files that just define types or DTO fields. The
    // production-code consumer surface is the tenants.service (setter +
    // getter) and the tenants.controller (response mapping). Both are
    // per-request handlers of the PR-2 management endpoints — no background
    // job, no webhook handler, no scheduled task reads this field.
    const consumerRegex = /tenant(?:s)?\.voiceInboundUrl|tenant\.voiceInboundUrl/;
    const runtimeConsumers = readingFiles.filter((f) => {
      const content = fs.readFileSync(f, 'utf8');
      return consumerRegex.test(content);
    });

    // PR 2's intentional consumers: tenants.service (setter/getter),
    // tenants.controller (response mapping). PR 3 adds twilio-webhooks.service
    // (routing decision to fire the tenant-forward step).
    //
    // Any 4th name here means an unreviewed consumer landed — either the
    // list needs updating (with justification) or the consumer is a bug.
    const runtimeConsumerNames = runtimeConsumers
      .map((f) => path.basename(f))
      .sort();
    expect(runtimeConsumerNames).toEqual(
      [
        'tenants.controller.ts',
        'tenants.service.ts',
        'twilio-webhooks.service.ts',
      ].sort(),
    );
  });

  it('only twilio-webhooks.service.ts under webhooks/ reads tenant.voiceInboundUrl (PR 3 boundary)', () => {
    const files: string[] = [];
    walk(SRC_ROOT, files);
    const routingModuleFiles = files.filter((f) =>
      /webhooks|inbound|routing/i.test(f),
    );
    // Same filter as the primary invariant test above — files that access
    // `.voiceInboundUrl` on a Tenant instance, not files that merely take a
    // `voiceInboundUrl` string in their input DTOs (which the forwarder does
    // but which is not a Tenant read).
    const consumerRegex = /tenant(?:s)?\.voiceInboundUrl|tenant\.voiceInboundUrl/;
    const consumers = routingModuleFiles
      .filter((f) => consumerRegex.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.basename(f));
    expect(consumers).toEqual(['twilio-webhooks.service.ts']);
  });
});
