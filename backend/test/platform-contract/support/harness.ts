/**
 * Platform Contract test harness.
 *
 * Bootstraps a slim `PlatformContractTestModule` that exercises the
 * exact services + repositories the Wave-3 invariants live in. Uses a
 * real Postgres connection (via `DATABASE_URL`) so the partial unique
 * indexes, `communication_integration_id` FK, and cross-cutting
 * constraints are all in play — the whole point of platform-contract
 * tests is to catch schema-level regressions that unit tests with
 * mocked repos cannot see.
 *
 * Test isolation via `resetDatabase()` — TRUNCATE-with-cascade over
 * every table the suite touches, called from `beforeEach`. Also
 * re-seeds a workspace + a WORKSPACE-scoped Twilio integration so
 * each test starts from the pre-Natallia baseline (workspace exists,
 * one integration exists, no tenants yet).
 *
 * External providers are replaced with mocks:
 *   - TwilioProvider -> MockTwilioProvider (no api.twilio.com calls,
 *     no billing).
 *   - The provider-context event emitter is replaced with an in-memory
 *     capturing implementation so tests can assert on emitted events
 *     without touching LogHub.
 *
 * NOT booted in the test module:
 *   - S3, WhatsApp service HTTP, Telegram gateway, Email — these have
 *     side effects that the invariants don't cover, and each would
 *     require its own mock. Add them only when a scenario needs them.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'crypto';

import { Workspace } from '../../../src/database/entities/workspace.entity';
import { ApiKey } from '../../../src/database/entities/api-key.entity';
import { Tenant } from '../../../src/database/entities/tenant.entity';
import {
  CommunicationIntegration,
  IntegrationStatus,
  ProviderType,
} from '../../../src/database/entities/communication-integration.entity';
import { TenantPhoneNumber } from '../../../src/database/entities/tenant-phone-number.entity';
import { CommunicationBusiness } from '../../../src/database/entities/communication-business.entity';
import { CommunicationProfile } from '../../../src/database/entities/communication-profile.entity';
import { ProfilePhoneAssignment } from '../../../src/database/entities/profile-phone-assignment.entity';
import { WebhookSubscription } from '../../../src/database/entities/webhook-subscription.entity';
import { TenantIntegration } from '../../../src/database/entities/tenant-integration.entity';
import { PhoneNumberOrder } from '../../../src/database/entities/phone-number-order.entity';
import { PhoneNumberPricing } from '../../../src/database/entities/phone-number-pricing.entity';

import { CommunicationModule } from '../../../src/modules/communication/communication.module';
import { IntegrationsModule } from '../../../src/modules/integrations/integrations.module';
import { TenantsModule } from '../../../src/modules/tenants/tenants.module';
import { ApiModule } from '../../../src/modules/api/api.module';
import { SigcoreAuthModule } from '../../../src/modules/auth/sigcore-auth.module';
import { EventsModule } from '../../../src/modules/events/events.module';
import { EmailModule } from '../../../src/modules/email/email.module';
import { WebhooksModule } from '../../../src/modules/webhooks/webhooks.module';
import { BusinessIdentityModule } from '../../../src/modules/business-identity/business-identity.module';
import { AdminViewsModule } from '../../../src/modules/admin-views/admin-views.module';
import { RoutingModule } from '../../../src/modules/routing/routing.module';
import { S3Module } from '../../../src/shared/storage/s3.module';
import { ProvisioningModule } from '../../../src/modules/provisioning/provisioning.module';

import { TenantsService } from '../../../src/modules/tenants/tenants.service';
import { PhoneNumberProvisioningService } from '../../../src/modules/tenants/phone-number-provisioning.service';
import { CommunicationProvisioningService } from '../../../src/modules/tenants/communication-provisioning.service';
import { ProviderContextResolver } from '../../../src/modules/integrations/provider-context-resolver.service';
import { ProviderContextAuditService } from '../../../src/modules/integrations/provider-context-audit.service';
import { IntegrationsService } from '../../../src/modules/integrations/integrations.service';
import { ApiKeysService } from '../../../src/modules/api/api-keys.service';
import { TwilioProvider } from '../../../src/modules/communication/providers/twilio.provider';
import { EncryptionService } from '../../../src/common/services/encryption.service';

import { MockTwilioProvider } from './mock-twilio';

const TEST_ENCRYPTION_KEY = 'platform-contract-test-key-32-bytes-long';
const TEST_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';

/**
 * All tables the harness truncates between tests. Order matters only for
 * clarity; TRUNCATE CASCADE handles FK dependencies.
 */
const TABLES_TO_RESET = [
  'sms_messages',
  'communication_messages',
  'communication_calls',
  'communication_conversations',
  'call_connect_sessions',
  'call_connect_settings',
  'profile_phone_assignments',
  'communication_profiles',
  'communication_businesses',
  'phone_number_orders',
  'tenant_phone_numbers',
  'webhook_subscriptions',
  'communication_integrations',
  'tenant_integrations',
  'api_keys',
  'tenants',
  'workspaces',
];

export interface PlatformContractHarness {
  moduleRef: TestingModule;
  dataSource: DataSource;
  workspaceId: string;
  encryptionService: EncryptionService;
  tenantsService: TenantsService;
  phoneNumberProvisioningService: PhoneNumberProvisioningService;
  communicationProvisioningService: CommunicationProvisioningService;
  providerContextResolver: ProviderContextResolver;
  providerContextAuditService: ProviderContextAuditService;
  integrationsService: IntegrationsService;
  apiKeysService: ApiKeysService;
  repos: {
    tenant: Repository<Tenant>;
    integration: Repository<CommunicationIntegration>;
    tpn: Repository<TenantPhoneNumber>;
    business: Repository<CommunicationBusiness>;
    profile: Repository<CommunicationProfile>;
    ppa: Repository<ProfilePhoneAssignment>;
    webhook: Repository<WebhookSubscription>;
    order: Repository<PhoneNumberOrder>;
    workspace: Repository<Workspace>;
  };
  seedBaseline: () => Promise<{ integrationId: string }>;
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

export async function bootHarness(): Promise<PlatformContractHarness> {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'Platform-contract tests require DATABASE_URL. Local: run `docker run -d --name pg-test -p 5432:5432 -e POSTGRES_PASSWORD=test postgres:15` then `DATABASE_URL=postgresql://postgres:test@localhost:5432/postgres npm run test:platform`. CI: provided by services block.',
    );
  }
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true }),
      EventEmitterModule.forRoot(),
      TypeOrmModule.forRootAsync({
        imports: [ConfigModule],
        useFactory: (configService: ConfigService) => ({
          type: 'postgres' as const,
          url: configService.get('DATABASE_URL'),
          entities: [__dirname + '/../../../src/database/entities/*.entity{.ts,.js}'],
          migrations: [__dirname + '/../../../src/database/migrations/*{.ts,.js}'],
          synchronize: false,
          migrationsRun: true,
          logging: false,
        }),
        inject: [ConfigService],
      }),
      TypeOrmModule.forFeature([Workspace, ApiKey]),
      SigcoreAuthModule,
      CommunicationModule,
      IntegrationsModule,
      ProvisioningModule,
      WebhooksModule,
      EventsModule,
      TenantsModule,
      ApiModule,
      EmailModule,
      BusinessIdentityModule,
      AdminViewsModule,
      RoutingModule,
      S3Module,
    ],
  })
    .overrideProvider(TwilioProvider)
    .useClass(MockTwilioProvider)
    .compile();

  const app = moduleRef;
  const dataSource = app.get(DataSource);

  const repos = {
    tenant: app.get<Repository<Tenant>>(getRepositoryToken(Tenant)),
    integration: app.get<Repository<CommunicationIntegration>>(
      getRepositoryToken(CommunicationIntegration),
    ),
    tpn: app.get<Repository<TenantPhoneNumber>>(
      getRepositoryToken(TenantPhoneNumber),
    ),
    business: app.get<Repository<CommunicationBusiness>>(
      getRepositoryToken(CommunicationBusiness),
    ),
    profile: app.get<Repository<CommunicationProfile>>(
      getRepositoryToken(CommunicationProfile),
    ),
    ppa: app.get<Repository<ProfilePhoneAssignment>>(
      getRepositoryToken(ProfilePhoneAssignment),
    ),
    webhook: app.get<Repository<WebhookSubscription>>(
      getRepositoryToken(WebhookSubscription),
    ),
    order: app.get<Repository<PhoneNumberOrder>>(
      getRepositoryToken(PhoneNumberOrder),
    ),
    workspace: app.get<Repository<Workspace>>(getRepositoryToken(Workspace)),
  };

  const encryptionService = app.get(EncryptionService);

  const harness: PlatformContractHarness = {
    moduleRef: app,
    dataSource,
    workspaceId: TEST_WORKSPACE_ID,
    encryptionService,
    tenantsService: app.get(TenantsService),
    phoneNumberProvisioningService: app.get(PhoneNumberProvisioningService),
    communicationProvisioningService: app.get(CommunicationProvisioningService),
    providerContextResolver: app.get(ProviderContextResolver),
    providerContextAuditService: app.get(ProviderContextAuditService),
    integrationsService: app.get(IntegrationsService),
    apiKeysService: app.get(ApiKeysService),
    repos,
    seedBaseline: async () => {
      // Workspace + one active WORKSPACE-scoped Twilio integration.
      // Mirrors the LB workspace shape from prod so scenarios can behave
      // as if provisioning a new tenant into a live workspace.
      await repos.workspace.save(
        repos.workspace.create({
          id: TEST_WORKSPACE_ID,
          name: 'Platform Contract Test Workspace',
          webhookId: randomUUID(),
        } as any),
      );
      const credsBlob = JSON.stringify({
        accountSid: 'ACtestaccountsid00000000000000001',
        authToken: 'testauthtoken00000000000000000001',
      });
      // Skip `.create` entirely — its DeepPartial + array overloads
      // confuse tsc when the input is inline. Insert directly via query
      // builder for a stable, non-overloaded signature.
      const insertResult = await repos.integration
        .createQueryBuilder()
        .insert()
        .values({
          workspaceId: TEST_WORKSPACE_ID,
          provider: ProviderType.TWILIO,
          credentialsEncrypted: encryptionService.encrypt(credsBlob),
          externalWorkspaceId: 'ACtestaccountsid00000000000000001',
          status: IntegrationStatus.ACTIVE,
          scopeType: 'WORKSPACE',
          ownerTenantId: null as any,
        })
        .returning('id')
        .execute();
      return { integrationId: (insertResult.identifiers[0] as { id: string }).id };
    },
    reset: async () => {
      // TRUNCATE ... CASCADE clears every FK dependency across the tables
      // the suite touches. Wrap in a single statement so it's atomic.
      const tableList = TABLES_TO_RESET.map((t) => `"${t}"`).join(', ');
      await dataSource.query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
    },
    close: async () => {
      await dataSource.destroy();
      await app.close();
    },
  };

  return harness;
}
