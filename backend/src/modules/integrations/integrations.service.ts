import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import {
  CommunicationIntegration,
  OperationalStatus,
  ProviderType,
  IntegrationStatus,
} from '../../database/entities/communication-integration.entity';
import { TenantIntegration } from '../../database/entities/tenant-integration.entity';
import {
  TenantPhoneNumber,
  PhoneNumberProvider,
  PhoneNumberAllocationStatus,
} from '../../database/entities/tenant-phone-number.entity';
import { ChannelType } from '../../database/entities/sender.entity';
import { Tenant } from '../../database/entities/tenant.entity';
import { Workspace } from '../../database/entities/workspace.entity';
import { ContactIdentity } from '../../database/entities/contact-identity.entity';
import { OpenPhoneContactSnapshot } from '../../database/entities/openphone-contact-snapshot.entity';
import { CommunicationParticipant } from '../../database/entities/communication-participant.entity';
import { EncryptionService } from '../../common/services/encryption.service';
import { OpenPhoneProvider } from '../communication/providers/openphone.provider';
import { TwilioProvider } from '../communication/providers/twilio.provider';
import { TwilioVoiceService } from '../communication/twilio-voice.service';
import { VoiceIdentity } from '../communication/voice-identity';
import { ProviderContextResolver } from './provider-context-resolver.service';
import { normalizeToE164, last10Digits } from '../../common/util/phone';
import { OpenPhoneContactCacheService, resolveDisplayName } from './openphone-contact-cache.service';
import {
  SetupIntegrationDto,
  SetupTwilioIntegrationDto,
  UpdateTwilioPhoneNumberDto,
  EnsureIntegrationDto,
  EnsureIntegrationResult,
} from './dto';

export interface IntegrationInfo {
  id: string;
  provider: ProviderType;
  status: IntegrationStatus;
  externalWorkspaceId?: string;
  webhookUrl: string;
  hasWebhookSecret: boolean;
  webhooksRegistered: boolean;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

export interface TwilioPhoneNumberInfo {
  sid: string;
  phoneNumber: string;
  friendlyName?: string;
  capabilities: {
    voice: boolean;
    sms: boolean;
    mms: boolean;
  };
  // A2P 10DLC compliance status
  a2pCompliance?: {
    isRegistered: boolean;
    campaignStatus?: string;
    messagingServiceSid?: string;
  };
}

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    @InjectRepository(CommunicationIntegration)
    private integrationRepo: Repository<CommunicationIntegration>,
    @InjectRepository(TenantIntegration)
    private tenantIntegrationRepo: Repository<TenantIntegration>,
    @InjectRepository(TenantPhoneNumber)
    private tenantPhoneRepo: Repository<TenantPhoneNumber>,
    @InjectRepository(Tenant)
    private tenantRepo: Repository<Tenant>,
    @InjectRepository(Workspace)
    private workspaceRepo: Repository<Workspace>,
    @InjectRepository(ContactIdentity)
    private contactIdentityRepo: Repository<ContactIdentity>,
    @InjectRepository(OpenPhoneContactSnapshot)
    private snapshotRepo: Repository<OpenPhoneContactSnapshot>,
    @InjectRepository(CommunicationParticipant)
    private participantRepo: Repository<CommunicationParticipant>,
    private readonly openPhoneContactCache: OpenPhoneContactCacheService,
    private encryptionService: EncryptionService,
    private openPhoneProvider: OpenPhoneProvider,
    private twilioProvider: TwilioProvider,
    private twilioVoiceService: TwilioVoiceService,
    private configService: ConfigService,
    // Browser Voice Contract — provider-context resolver is optional to
    // preserve backwards-compat for unit specs constructing this service
    // directly. When absent, `generateOutgoingCallTwiML` skips the ownership
    // check (log-only) — the primary enforcement site is
    // `TwilioWebhooksService.handleOutgoingCall`, which the TwiML App
    // actually hits on browser calls.
    @Optional()
    private providerContextResolver?: ProviderContextResolver,
  ) {}

  /**
   * Find or create a workspace record. Since the auth guard already validates
   * the service key, we trust the workspaceId and auto-create the reference
   * record when it doesn't exist (first time a workspace uses Sigcore).
   */
  private async ensureWorkspace(workspaceId: string): Promise<Workspace> {
    let workspace = await this.workspaceRepo.findOne({
      where: { id: workspaceId },
    });

    if (!workspace) {
      this.logger.log(`Auto-creating workspace record for ${workspaceId}`);
      workspace = this.workspaceRepo.create({
        id: workspaceId,
        name: `Workspace ${workspaceId.substring(0, 8)}`,
        webhookId: crypto.randomBytes(16).toString('hex'),
      });
      await this.workspaceRepo.save(workspace);
    }

    return workspace;
  }

  /**
   * Resolve the base URL for webhook registration.
   * Checks multiple sources: ConfigService, process.env, Railway auto-injected domain.
   */
  private getBaseUrl(): string {
    return (
      this.configService.get('BASE_URL') ||
      process.env.BASE_URL ||
      (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null) ||
      'http://localhost:3002'
    );
  }

  /**
   * Get integration by provider type. If no provider specified, returns the first active integration.
   */
  async getIntegration(workspaceId: string, provider?: ProviderType): Promise<IntegrationInfo | null> {
    const whereClause: { workspaceId: string; provider?: ProviderType } = { workspaceId };
    if (provider) {
      whereClause.provider = provider;
    }

    const integration = await this.integrationRepo.findOne({
      where: whereClause,
    });

    if (!integration) {
      return null;
    }

    return this.mapIntegrationToInfo(integration);
  }

  /**
   * Get all integrations for a workspace.
   */
  async getIntegrations(workspaceId: string): Promise<IntegrationInfo[]> {
    const integrations = await this.integrationRepo.find({
      where: { workspaceId },
    });

    return Promise.all(integrations.map((i) => this.mapIntegrationToInfo(i)));
  }

  private async mapIntegrationToInfo(integration: CommunicationIntegration): Promise<IntegrationInfo> {
    const workspace = await this.workspaceRepo.findOne({
      where: { id: integration.workspaceId },
    });

    const baseUrl = this.getBaseUrl();
    const metadata = integration.metadata || {};

    // Determine webhook URL based on provider
    let webhookUrl: string;
    let webhooksRegistered: boolean;

    if (integration.provider === ProviderType.TWILIO) {
      webhookUrl = `${baseUrl}/api/webhooks/twilio/sms/${workspace?.webhookId}`;
      webhooksRegistered = !!(metadata.smsWebhookConfigured || metadata.voiceWebhookConfigured);
    } else {
      webhookUrl = `${baseUrl}/api/webhooks/openphone/${workspace?.webhookId}`;
      webhooksRegistered = !!(metadata.messageWebhookId || metadata.callWebhookId);
    }

    return {
      id: integration.id,
      provider: integration.provider,
      status: integration.status,
      externalWorkspaceId: integration.externalWorkspaceId,
      webhookUrl,
      hasWebhookSecret: !!integration.webhookSecretEncrypted,
      webhooksRegistered,
      createdAt: integration.createdAt,
      metadata: {
        phoneNumber: metadata.phoneNumber,
        phoneNumberSid: metadata.phoneNumberSid,
        friendlyName: metadata.friendlyName,
      },
    };
  }

  /**
   * Setup OpenPhone integration.
   */
  async setupIntegration(
    workspaceId: string,
    dto: SetupIntegrationDto,
  ): Promise<IntegrationInfo> {
    // Validate API key
    const credentials = JSON.stringify({ apiKey: dto.apiKey });
    const isValid = await this.openPhoneProvider.validateCredentials(credentials);

    if (!isValid) {
      throw new BadRequestException('Invalid OpenPhone API key');
    }

    const encryptedCredentials = this.encryptionService.encrypt(credentials);

    // Get or create workspace to construct webhook URL
    const workspace = await this.ensureWorkspace(workspaceId);

    const baseUrl = this.getBaseUrl();
    const webhookUrl = `${baseUrl}/api/webhooks/openphone/${workspace.webhookId}`;
    this.logger.log(`Webhook URL for workspace ${workspaceId}: ${webhookUrl} (BASE_URL config=${this.configService.get('BASE_URL')}, env=${process.env.BASE_URL}, railway=${process.env.RAILWAY_PUBLIC_DOMAIN})`);

    // Wave-3 completion 2026-07-18: constrain to WORKSPACE-scoped row only.
    // Since Wave-2, a workspace may hold multiple integrations for the same
    // provider (workspace-scoped + N tenant-scoped). `setupIntegration` is
    // the workspace-level setup entry point and must never rotate a
    // tenant-scoped row's credentials. The partial unique index guarantees
    // there is at most one WORKSPACE-scoped row per (workspace, provider).
    let integration = await this.integrationRepo.findOne({
      where: { workspaceId, provider: dto.provider, ownerTenantId: IsNull() },
    });

    // Delete old webhooks if updating an existing integration
    if (integration?.metadata) {
      const oldMetadata = integration.metadata as { messageWebhookId?: string; callWebhookId?: string };
      if (oldMetadata.messageWebhookId || oldMetadata.callWebhookId) {
        this.logger.log('Deleting old webhooks before re-registering...');
        await this.openPhoneProvider.deleteWebhooks(credentials, {
          messageWebhookId: oldMetadata.messageWebhookId,
          callWebhookId: oldMetadata.callWebhookId,
        });
      }
    }

    // Register webhooks with OpenPhone
    this.logger.log(`Registering webhooks for workspace ${workspaceId}...`);
    const webhookResult = await this.openPhoneProvider.registerWebhooks(credentials, webhookUrl);

    let encryptedWebhookSecret: string | null = null;
    if (webhookResult.webhookKey) {
      // Use the webhook key from OpenPhone for signature verification
      encryptedWebhookSecret = this.encryptionService.encrypt(webhookResult.webhookKey);
      this.logger.log('Stored webhook secret from OpenPhone');
    } else if (dto.webhookSecret) {
      // Fall back to manually provided webhook secret
      encryptedWebhookSecret = this.encryptionService.encrypt(dto.webhookSecret);
    }

    // Build metadata with webhook IDs
    const metadata = {
      messageWebhookId: webhookResult.messageWebhookId,
      callWebhookId: webhookResult.callWebhookId,
      webhooksRegisteredAt: new Date().toISOString(),
    };

    if (integration) {
      integration.credentialsEncrypted = encryptedCredentials;
      integration.webhookSecretEncrypted = encryptedWebhookSecret ?? undefined;
      integration.externalWorkspaceId = dto.externalWorkspaceId;
      integration.status = IntegrationStatus.ACTIVE;
      integration.metadata = metadata;
    } else {
      integration = this.integrationRepo.create({
        workspaceId,
        provider: dto.provider,
        credentialsEncrypted: encryptedCredentials,
        webhookSecretEncrypted: encryptedWebhookSecret ?? undefined,
        externalWorkspaceId: dto.externalWorkspaceId,
        status: IntegrationStatus.ACTIVE,
        // Wave-3 completion 2026-07-18: explicit scope stamp. Workspace-level
        // setup always creates a WORKSPACE-scoped row.
        scopeType: 'WORKSPACE',
        ownerTenantId: null,
        metadata,
      });
    }

    await this.integrationRepo.save(integration);

    if (webhookResult.success) {
      this.logger.log(`Webhooks registered successfully for workspace ${workspaceId}`);
    } else {
      this.logger.warn(`Webhook registration failed: ${webhookResult.error}. Manual registration required.`);
    }

    return this.getIntegration(workspaceId, dto.provider) as Promise<IntegrationInfo>;
  }

  /**
   * Idempotent ensure of a (workspaceId, tenantId, provider) integration row.
   *
   * Wave-2 Task 1 (see Wave-2 Migration Runbook §Task 1). This is the
   * permanent registration mechanism used by Callio's boot-time registrar to
   * guarantee a `CommunicationIntegration` row exists for each voice-enabled
   * workspace × tenant × provider triplet. It is deliberately additive to the
   * existing setup* endpoints (which register webhooks with the provider) and
   * does NOT perform any provider-side API calls.
   *
   * Semantics:
   *   - Look up existing row on (workspaceId, tenantId, provider). Note that
   *     the on-disk uniqueness is (workspaceId, provider) — see the entity's
   *     @Index. `tenantId` is an additive scoping key kept in metadata for
   *     rows registered via this path so multiple tenants in the same
   *     workspace can share credentials until Wave-3's subaccount split.
   *   - If credentials supplied: rotate. The existing decrypted credentials
   *     JSON is merged with the new fields ("new wins" per key) and the
   *     result is re-encrypted. This lets Callio pass just accountSid+authToken
   *     without wiping out webhook secrets already in place.
   *   - If credentials absent: **probe mode.** Existing row returned
   *     unchanged. If no row exists, throw NotFoundException — DO NOT
   *     create an empty-credentials row. This lets Callio's Task 2
   *     registrar distinguish "already registered" from "needs migration
   *     mode" without polluting Sigcore state on ordinary boots.
   *     Refinement 2026-07-11 per Wave-2 Task 2 transition contract.
   *   - Returns { id, created, workspaceId, tenantId, provider }.
   *   - Concurrent calls: race on the (workspaceId, provider) unique index —
   *     the loser retries the find so exactly one row ends up in the table.
   *     This is by design: the runbook's `ensure_concurrent_calls_race_produces_one_row`
   *     test asserts single-row outcome.
   */
  async ensureIntegration(
    workspaceId: string,
    dto: EnsureIntegrationDto,
  ): Promise<EnsureIntegrationResult> {
    if (!dto.tenantId) {
      throw new BadRequestException('tenantId is required');
    }
    if (!dto.provider) {
      throw new BadRequestException('provider is required');
    }

    // Workspace-tenant ownership check — mirrors IntegrationResourceGuard
    // check=1 but locally, since ensure is the entry point.
    const tenant = await this.tenantRepo.findOne({
      where: { id: dto.tenantId, workspaceId },
    });
    if (!tenant) {
      throw new NotFoundException(
        `Tenant ${dto.tenantId} not found in workspace ${workspaceId}`,
      );
    }

    await this.ensureWorkspace(workspaceId);

    const runOnce = async (): Promise<EnsureIntegrationResult> => {
      // Incident 2026-07-14 Phase 5a — tenant-preferred lookup.
      //
      // A workspace may now hold TWO integrations for the same provider:
      //   - workspace-scoped (owner_tenant_id IS NULL) — the LB shared row
      //   - tenant-scoped (owner_tenant_id = X) — the Callio row
      //
      // Prefer the tenant-scoped row when it matches the caller's tenantId.
      // Fall back to the workspace-scoped row so pre-Wave-2 callers still
      // resolve to the legacy shared row without needing a schema-aware
      // client change.
      let existing = await this.integrationRepo.findOne({
        where: {
          workspaceId,
          provider: dto.provider,
          ownerTenantId: dto.tenantId,
        },
      });
      if (!existing) {
        existing = await this.integrationRepo.findOne({
          where: {
            workspaceId,
            provider: dto.provider,
            ownerTenantId: IsNull(),
          },
        });
      }

      if (existing) {
        // ------------------------------------------------------------------
        // Ownership guard — Incident 2026-07-14.
        //
        // A workspace-level integration row may already be owned by a
        // different tenant. Silently rotating its credentials (as we did
        // pre-guard) caused a cross-tenant credential clobber that broke
        // every LB tenant's outbound Twilio for ~7 minutes.
        //
        // Semantics:
        //   1. Non-legacy row (metadata.ensure.tenantId present):
        //        - same tenant  → fall through, rotate as normal
        //        - other tenant + creds  → 409 IntegrationOwnershipConflict
        //        - other tenant + probe  → 403 IntegrationAccessDenied
        //          (body must NOT leak integrationId)
        //   2. Legacy row (no metadata.ensure.tenantId):
        //        - probe               → allow (unchanged)
        //        - rotation w/o flag   → 409 IntegrationOwnershipConflict
        //          reason=legacy_row_frozen_without_allowLegacyClaim
        //        - rotation with flag  → allow; stamp tenantId +
        //          claimedFromLegacyAt in metadata.ensure
        //
        // NEVER log credentials, auth tokens, or the accountSid values.
        // ------------------------------------------------------------------
        const existingMeta = (existing.metadata as Record<string, unknown>) || {};
        const existingEnsureMeta =
          (existingMeta.ensure as Record<string, unknown>) || {};
        const existingTenantId =
          typeof existingEnsureMeta.tenantId === 'string'
            ? (existingEnsureMeta.tenantId as string)
            : null;
        const hasCredentials =
          !!dto.credentials && Object.keys(dto.credentials).length > 0;

        if (existingTenantId !== null) {
          // Non-legacy row: enforce tenant match strictly.
          if (existingTenantId !== dto.tenantId) {
            if (hasCredentials) {
              this.logger.warn(
                `[IntegrationGuard] cross_tenant_rotation_rejected workspaceId=${workspaceId} existingTenantId=${existingTenantId} requestedTenantId=${dto.tenantId} integrationId=${existing.id} provider=${dto.provider}`,
              );
              throw new ConflictException({
                error: 'IntegrationOwnershipConflict',
                existingTenantId,
                requestedTenantId: dto.tenantId,
                integrationId: existing.id,
                workspaceId,
                provider: dto.provider,
              });
            }
            this.logger.warn(
              `[IntegrationGuard] cross_tenant_probe_denied workspaceId=${workspaceId} existingTenantId=${existingTenantId} requestedTenantId=${dto.tenantId} integrationId=${existing.id} provider=${dto.provider}`,
            );
            throw new ForbiddenException({
              error: 'IntegrationAccessDenied',
              existingTenantId,
              requestedTenantId: dto.tenantId,
              workspaceId,
              provider: dto.provider,
            });
          }
        } else if (hasCredentials && !dto.allowLegacyClaim) {
          // Legacy row + rotation attempt without opt-in → freeze.
          this.logger.warn(
            `[IntegrationGuard] cross_tenant_rotation_rejected workspaceId=${workspaceId} existingTenantId=null requestedTenantId=${dto.tenantId} integrationId=${existing.id} provider=${dto.provider}`,
          );
          throw new ConflictException({
            error: 'IntegrationOwnershipConflict',
            reason: 'legacy_row_frozen_without_allowLegacyClaim',
            existingTenantId: null,
            requestedTenantId: dto.tenantId,
            integrationId: existing.id,
            workspaceId,
            provider: dto.provider,
          });
        }

        // Rotate iff credentials supplied.
        if (dto.credentials && Object.keys(dto.credentials).length > 0) {
          let existingCreds: Record<string, unknown> = {};
          try {
            existingCreds = JSON.parse(
              this.encryptionService.decrypt(existing.credentialsEncrypted),
            );
          } catch {
            existingCreds = {};
          }
          const merged = { ...existingCreds, ...dto.credentials };
          existing.credentialsEncrypted = this.encryptionService.encrypt(
            JSON.stringify(merged),
          );
          if (dto.providerAccountId) {
            existing.externalWorkspaceId = dto.providerAccountId;
          }
          const metadata = (existing.metadata as Record<string, unknown>) || {};
          const ensureMeta = (metadata.ensure as Record<string, unknown>) || {};
          const legacyClaimStamp =
            existingTenantId === null && dto.allowLegacyClaim
              ? { claimedFromLegacyAt: new Date().toISOString() }
              : {};
          metadata.ensure = {
            ...ensureMeta,
            tenantId: dto.tenantId,
            lastRotatedAt: new Date().toISOString(),
            friendlyName: dto.friendlyName ?? ensureMeta.friendlyName,
            ...legacyClaimStamp,
          };
          existing.metadata = metadata;
          await this.integrationRepo.save(existing);
          this.logger.log(
            `[ensureIntegration] rotated credentials for workspace=${workspaceId} tenant=${dto.tenantId} provider=${dto.provider} id=${existing.id}`,
          );
        } else {
          this.logger.log(
            `[ensureIntegration] returning existing row for workspace=${workspaceId} tenant=${dto.tenantId} provider=${dto.provider} id=${existing.id} (no credentials supplied)`,
          );
        }
        return toEnsureResult(existing, false, workspaceId, dto.tenantId);
      }

      // Probe mode — refuse to create an empty-credentials row.
      // Callers on ordinary boots (no migration mode) MUST get a 404 here
      // so they don't accidentally register an unusable integration.
      if (!dto.credentials || Object.keys(dto.credentials).length === 0) {
        throw new NotFoundException(
          `No integration exists for workspace ${workspaceId} provider ${dto.provider} — probe returned nothing. To create, resubmit with credentials.`,
        );
      }

      const credsBlob = JSON.stringify(dto.credentials);
      const created = this.integrationRepo.create({
        workspaceId,
        provider: dto.provider,
        credentialsEncrypted: this.encryptionService.encrypt(credsBlob),
        externalWorkspaceId: dto.providerAccountId,
        status: IntegrationStatus.ACTIVE,
        // Task 6B.5A: rows created via ensure with credentials are treated
        // as grandfathered ready — the caller (pilot registrar, admin
        // migration script) is asserting these credentials work. The lazy
        // subaccount provisioner is only invoked for rows in
        // `pending_credentials`, which is the state Task 6B.2 provisioning
        // sets. Legacy ensure creations leave operationalStatus NULL so
        // the response reports `ready`.
        metadata: {
          ensure: {
            tenantId: dto.tenantId,
            friendlyName: dto.friendlyName,
            createdAt: new Date().toISOString(),
          },
        },
      });
      const saved = await this.integrationRepo.save(created);
      this.logger.log(
        `[ensureIntegration] created workspace=${workspaceId} tenant=${dto.tenantId} provider=${dto.provider} id=${saved.id}`,
      );
      return toEnsureResult(saved, true, workspaceId, dto.tenantId);
    };

    try {
      return await runOnce();
    } catch (err: any) {
      // Concurrent race on unique (workspaceId, provider) index — retry the
      // lookup path once. The winning row is now visible; second caller
      // reports created:false.
      const code = err?.code || err?.driverError?.code;
      if (code === '23505') {
        this.logger.warn(
          `[ensureIntegration] unique-violation race for workspace=${workspaceId} provider=${dto.provider} — re-reading winning row`,
        );
        const existing = await this.integrationRepo.findOne({
          where: { workspaceId, provider: dto.provider },
        });
        if (existing) {
          return toEnsureResult(existing, false, workspaceId, dto.tenantId);
        }
      }
      throw err;
    }
  }

  /**
   * Setup Twilio integration.
   */
  async setupTwilioIntegration(
    workspaceId: string,
    dto: SetupTwilioIntegrationDto,
  ): Promise<IntegrationInfo> {
    // Validate Twilio credentials
    const credentials = JSON.stringify({
      accountSid: dto.accountSid,
      authToken: dto.authToken,
      phoneNumber: dto.phoneNumber,
      phoneNumberSid: dto.phoneNumberSid,
    });

    const isValid = await this.twilioProvider.validateCredentials(credentials);

    if (!isValid) {
      throw new BadRequestException('Invalid Twilio credentials');
    }

    // Get or create workspace to construct webhook URL
    const workspace = await this.ensureWorkspace(workspaceId);

    const baseUrl = this.getBaseUrl();
    const smsWebhookUrl = `${baseUrl}/api/webhooks/twilio/sms/${workspace.webhookId}`;
    const voiceWebhookUrl = `${baseUrl}/api/webhooks/twilio/voice/${workspace.webhookId}`;

    // Automatically create API Key for Voice SDK
    this.logger.log('Creating Twilio API Key for Voice SDK...');
    const apiKeyResult = await this.twilioProvider.createApiKey(
      credentials,
      `Callio Voice - ${workspace.name || workspaceId}`,
    );

    if (!apiKeyResult.success) {
      this.logger.warn(`Failed to create API Key: ${apiKeyResult.error}`);
    }

    // Automatically create TwiML App for Voice
    this.logger.log('Creating TwiML App for Voice SDK...');
    const twimlAppResult = await this.twilioProvider.createTwiMLApp(
      credentials,
      `Callio Voice - ${workspace.name || workspaceId}`,
      voiceWebhookUrl,
    );

    if (!twimlAppResult.success) {
      this.logger.warn(`Failed to create TwiML App: ${twimlAppResult.error}`);
    }

    // Wave-3 completion 2026-07-18: constrain to WORKSPACE-scoped row only.
    // See same-file setupIntegration for rationale.
    let integration = await this.integrationRepo.findOne({
      where: { workspaceId, provider: ProviderType.TWILIO, ownerTenantId: IsNull() },
    });

    // Configure webhooks on Twilio phone number if provided
    let webhooksConfigured = false;
    if (dto.phoneNumberSid) {
      const webhookResult = await this.twilioProvider.configureWebhooks(
        credentials,
        dto.phoneNumberSid,
        smsWebhookUrl,
        voiceWebhookUrl,
      );
      webhooksConfigured = webhookResult.success;
      if (!webhookResult.success) {
        this.logger.warn(`Failed to configure Twilio webhooks: ${webhookResult.error}`);
      }
    }

    // Build metadata with voice credentials
    const metadata: any = {
      phoneNumber: dto.phoneNumber,
      phoneNumberSid: dto.phoneNumberSid,
      friendlyName: dto.friendlyName,
      smsWebhookUrl,
      voiceWebhookUrl,
      smsWebhookConfigured: webhooksConfigured,
      voiceWebhookConfigured: webhooksConfigured,
      webhooksConfiguredAt: webhooksConfigured ? new Date().toISOString() : undefined,
    };

    // Add voice SDK credentials if created successfully
    if (apiKeyResult.success && apiKeyResult.apiKey) {
      metadata.voiceApiKeySid = apiKeyResult.apiKey.sid;
      // Store the secret encrypted in credentials
      this.logger.log('Voice API Key created successfully');
    }

    if (twimlAppResult.success && twimlAppResult.twimlApp) {
      metadata.voiceTwimlAppSid = twimlAppResult.twimlApp.sid;
      this.logger.log('TwiML App created successfully');
    }

    // Update credentials to include voice API credentials
    const updatedCredentials = JSON.parse(credentials);
    if (apiKeyResult.success && apiKeyResult.apiKey) {
      updatedCredentials.voiceApiKey = apiKeyResult.apiKey.sid;
      updatedCredentials.voiceApiSecret = apiKeyResult.apiKey.secret;
    }
    if (twimlAppResult.success && twimlAppResult.twimlApp) {
      updatedCredentials.voiceTwimlAppSid = twimlAppResult.twimlApp.sid;
    }

    const encryptedCredentials = this.encryptionService.encrypt(JSON.stringify(updatedCredentials));

    // Store auth token encrypted as webhook secret for signature verification
    const encryptedAuthToken = this.encryptionService.encrypt(dto.authToken);

    if (integration) {
      integration.credentialsEncrypted = encryptedCredentials;
      integration.webhookSecretEncrypted = encryptedAuthToken;
      integration.status = IntegrationStatus.ACTIVE;
      integration.metadata = metadata;
    } else {
      integration = this.integrationRepo.create({
        workspaceId,
        provider: ProviderType.TWILIO,
        credentialsEncrypted: encryptedCredentials,
        webhookSecretEncrypted: encryptedAuthToken,
        status: IntegrationStatus.ACTIVE,
        // Wave-3 completion 2026-07-18: explicit scope stamp. Workspace-level
        // setup always creates a WORKSPACE-scoped row.
        scopeType: 'WORKSPACE',
        ownerTenantId: null,
        metadata,
      });
    }

    await this.integrationRepo.save(integration);

    this.logger.log(`Twilio integration saved for workspace ${workspaceId} with Voice SDK support`);

    return this.getIntegration(workspaceId, ProviderType.TWILIO) as Promise<IntegrationInfo>;
  }

  /**
   * Get phone numbers from Twilio account.
   */
  async getTwilioPhoneNumbers(workspaceId: string): Promise<TwilioPhoneNumberInfo[]> {
    const integration = await this.integrationRepo.findOne({
      where: { workspaceId, provider: ProviderType.TWILIO },
    });

    if (!integration) {
      throw new NotFoundException('Twilio integration not found');
    }

    const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);
    return this.twilioProvider.getPhoneNumbersArray(credentials);
  }

  /**
   * Get OpenPhone phone numbers for a workspace.
   */
  async getOpenPhoneNumbers(workspaceId: string): Promise<Array<{ id: string; number: string; name?: string; capabilities?: { sms: boolean; voice: boolean; mms: boolean } }>> {
    const integration = await this.integrationRepo.findOne({
      where: { workspaceId, provider: ProviderType.OPENPHONE },
    });

    if (!integration) {
      throw new NotFoundException('OpenPhone integration not found');
    }

    const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);
    const phoneNumberMap = await this.openPhoneProvider.getPhoneNumbersFromCredentials(credentials);

    return Array.from(phoneNumberMap.values()).map((pn) => ({
      id: pn.id,
      number: pn.number,
      name: pn.name,
      symbol: pn.symbol || null,
      capabilities: pn.capabilities,
    }));
  }

  async getOpenPhoneConversations(
    workspaceId: string,
    days: number = 1,
    phoneNumberId?: string,
    includeMessages: boolean = false,
    messageLimit: number = 50,
    tenantId?: string | null,
    skipContactLookup: boolean = false,
  ): Promise<any> {
    // Try tenant-scoped integration first, fall back to workspace-scoped
    let integration = null;
    if (tenantId) {
      integration = await this.tenantIntegrationRepo.findOne({
        where: { workspaceId, tenantId, provider: ProviderType.OPENPHONE },
      });
    }
    if (!integration) {
      integration = await this.integrationRepo.findOne({
        where: { workspaceId, provider: ProviderType.OPENPHONE },
      });
    }

    if (!integration) {
      throw new NotFoundException('OpenPhone integration not found');
    }

    const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);

    const conversations = await this.openPhoneProvider.getRecentConversations(credentials, days, phoneNumberId);

    // Contact name lookup (skip when caller already has names or wants speed)
    let contactNames = new Map<string, string>();
    if (!skipContactLookup) {
      const numbersNeedingLookup = conversations
        .filter(c => c.participantPhone && !c.conversationName)
        .map(c => c.participantPhone);

      this.logger.log(`${conversations.length} conversations, ${numbersNeedingLookup.length} need contact name lookup`);

      if (numbersNeedingLookup.length > 0) {
        contactNames = await this.openPhoneProvider.lookupContactNamesByPhone(
          credentials,
          numbersNeedingLookup,
        );
      }
    } else {
      this.logger.log(`${conversations.length} conversations (contact lookup skipped)`);
    }

    // Enrich: use conversationName first, then contact lookup, then null.
    // Also attach `provider.company` from the snapshot table so SF (and any
    // other consumer) can read the OpenPhone "Company" custom field without
    // calling /participants separately. Snapshot is workspace-scoped and
    // populated by /openphone/contacts/sync (or webhook upserts).
    const phonesForCompanyLookup = Array.from(new Set(
      conversations.map(c => c.participantPhone).filter(Boolean) as string[]
    ));
    const companyByPhone = new Map<string, { contactId: string | null; company: string | null; displayName: string | null }>();
    if (phonesForCompanyLookup.length > 0) {
      const e164s = phonesForCompanyLookup
        .map(p => { const { e164 } = normalizeToE164(p); return e164; })
        .filter(Boolean) as string[];
      if (e164s.length > 0) {
        const snapshots = await this.snapshotRepo
          .createQueryBuilder('s')
          .where('s.workspaceId = :ws', { ws: workspaceId })
          .andWhere('s.phoneE164 IN (:...phones)', { phones: e164s })
          .getMany();
        for (const s of snapshots) {
          companyByPhone.set(s.phoneE164, {
            contactId: s.providerContactId ?? null,
            company: s.providerCompany ?? null,
            displayName: [s.providerFirstName, s.providerLastName].filter(Boolean).join(' ') || s.providerCompany || null,
          });
        }
      }
    }

    const enriched: any[] = conversations.map(conv => {
      const contactName = conv.conversationName || contactNames.get(conv.participantPhone) || null;
      const { e164 } = normalizeToE164(conv.participantPhone);
      const snap = e164 ? companyByPhone.get(e164) : null;
      return {
        ...conv,
        contactName,
        provider: {
          name: 'openphone',
          contactId: snap?.contactId ?? null,
          displayName: snap?.displayName ?? null,
          company: snap?.company ?? null,
        },
      };
    });

    // If includeMessages requested, fetch messages + calls for each conversation in parallel batches
    if (includeMessages) {
      const BATCH_SIZE = 5;
      this.logger.log(`Fetching messages+calls for ${enriched.length} conversations (batch-of-${BATCH_SIZE}, limit ${messageLimit})`);

      for (let i = 0; i < enriched.length; i += BATCH_SIZE) {
        const batch = enriched.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(async (conv) => {
            if (!conv.participantPhone || !conv.phoneNumberId) return { messages: [], calls: [] };
            const [msgs, calls] = await Promise.all([
              this.openPhoneProvider.getMessages(
                credentials, 'live', conv.phoneNumberId, conv.participantPhone,
              ).catch(e => { this.logger.warn(`Messages error for ${conv.participantPhone}: ${e.message}`); return []; }),
              this.openPhoneProvider.getCallsForParticipant(
                credentials, conv.participantPhone, conv.phoneNumberId,
              ).catch(e => { this.logger.warn(`Calls error for ${conv.participantPhone}: ${e.message}`); return []; }),
            ]);

            // Enrich calls with recordings + transcripts (parallel, batch-of-3)
            for (let ci = 0; ci < calls.length; ci += 3) {
              const callBatch = calls.slice(ci, ci + 3);
              await Promise.allSettled(
                callBatch.map(async (call) => {
                  if (!call.providerCallId) return;
                  try {
                    const [recordings, transcriptResult] = await Promise.all([
                      this.openPhoneProvider.getCallRecordings(credentials, call.providerCallId)
                        .catch(() => ({ recordingUrl: null, voicemailUrl: null })),
                      this.openPhoneProvider.getCallTranscript(credentials, call.providerCallId)
                        .catch(() => null),
                    ]);
                    (call as any).recordingUrl = recordings.recordingUrl || call.recordingUrl;
                    (call as any).voicemailUrl = recordings.voicemailUrl || call.voicemailUrl;
                    (call as any).transcription = transcriptResult?.transcript || null;
                  } catch (e) { /* non-fatal */ }
                }),
              );
            }

            return { messages: msgs.slice(0, messageLimit), calls };
          }),
        );
        results.forEach((result, idx) => {
          const data = result.status === 'fulfilled' ? result.value : { messages: [], calls: [] };
          batch[idx].messages = data.messages;
          batch[idx].calls = data.calls;
        });
      }

      const totalMsgs = enriched.reduce((sum, c) => sum + (c.messages?.length || 0), 0);
      const totalCalls = enriched.reduce((sum, c) => sum + (c.calls?.length || 0), 0);
      this.logger.log(`Fetched ${totalMsgs} messages + ${totalCalls} calls across ${enriched.length} conversations`);
    }

    return enriched;
  }

  /**
   * Full sync: fetch ALL conversations from OpenPhone, parallel per phone number.
   * Uses the paginated getConversations() which fetches all pages sequentially per number,
   * but runs all phone numbers in parallel.
   */
  async getAllOpenPhoneConversations(
    workspaceId: string,
    includeMessages: boolean = false,
    messageLimit: number = 50,
    tenantId?: string | null,
  ): Promise<any[]> {
    // Resolve credentials
    let integration = null;
    if (tenantId) {
      integration = await this.tenantIntegrationRepo.findOne({
        where: { workspaceId, tenantId, provider: ProviderType.OPENPHONE },
      });
    }
    if (!integration) {
      integration = await this.integrationRepo.findOne({
        where: { workspaceId, provider: ProviderType.OPENPHONE },
      });
    }
    if (!integration) {
      throw new NotFoundException('OpenPhone integration not found');
    }
    const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);

    // Get all phone numbers
    const phoneNumberMap = await this.openPhoneProvider.getPhoneNumbersFromCredentials(credentials);
    const phoneIds = Array.from(phoneNumberMap.keys());
    this.logger.log(`Full sync: fetching ALL conversations for ${phoneIds.length} phone numbers in parallel`);

    // Fetch OpenPhone contacts in parallel with conversations — build phone→contact map for company enrichment.
    // OpenPhone allows duplicate contacts with the same phone number. Merge by first-non-null-field-wins so
    // the indexed entry for each phone has the best available company/firstName/lastName across duplicates.
    const normalizeDigits = (ph: string) => (ph || '').replace(/\D/g, '').slice(-10);
    const contactByPhone = new Map<string, { company: string | null; firstName: string | null; lastName: string | null }>();
    // Learned company dictionary — values/tokens that appear as company for >= 2 contacts.
    // Used to infer company when it's null but stuffed into firstName/lastName by bad data imports.
    const companyValueCounts = new Map<string, number>();
    const companyTokenCounts = new Map<string, number>();
    // Sibling-contact dictionary — OpenPhone users often create one contact per device
    // (e.g. "Stephen Jaros" with company and "Stephen Jaros cell phone" without).
    // Normalized name → company, so the empty sibling picks up its sibling's company.
    const nameToCompany = new Map<string, string>();
    const normalizeName = (first?: string | null, last?: string | null): string | null => {
      const combined = `${first || ''} ${last || ''}`.trim().toLowerCase();
      if (!combined) return null;
      const stripped = combined
        .replace(/\b(cell\s*phone|cell|mobile\s*phone|mobile|work\s*phone|work|home\s*phone|home|office\s*phone|office|other\s*phone|other|alt|alternate|2nd|second|#2)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      // Need at least 2 name tokens of 2+ chars to avoid false positives on common single names
      if (stripped.split(/\s+/).filter(t => t.length >= 2).length < 2) return null;
      return stripped;
    };
    const mergeContact = (key: string, c: { company?: string; firstName?: string; lastName?: string }) => {
      const existing = contactByPhone.get(key);
      contactByPhone.set(key, {
        company:   (existing?.company ?? null) || c.company || null,
        firstName: (existing?.firstName ?? null) || c.firstName || null,
        lastName:  (existing?.lastName ?? null) || c.lastName || null,
      });
    };
    // Self-healing — kick off a debounced background contact sync. Picks up
    // new Quo contacts + stale company updates without manual intervention.
    // No-op if the last sync was <5 min ago.
    if (tenantId) {
      this.openPhoneContactCache.scheduleBackgroundSync(workspaceId, tenantId);
    } else {
      const resolved = await this.openPhoneContactCache.resolveOpenPhoneTenant(workspaceId);
      if (resolved) this.openPhoneContactCache.scheduleBackgroundSync(workspaceId, resolved);
    }

    // PR3 — read path cutover. Primary source: DB snapshot cache.
    // Fallback: live /contacts pagination for tenants without any cached snapshots.
    let usedLiveFallback = false;
    const contactsPromise = (async () => {
      const snapshots = await this.snapshotRepo.find({ where: { workspaceId } });
      if (snapshots.length === 0) {
        this.logger.warn(`openphone cache: no snapshots for workspace=${workspaceId}, falling back to live /contacts pagination`);
        usedLiveFallback = true;
        try {
          const contacts = await this.openPhoneProvider.getOpenPhoneContacts(credentials);
          for (const c of contacts) {
            if (c.company) {
              companyValueCounts.set(c.company, (companyValueCounts.get(c.company) || 0) + 1);
              for (const tok of c.company.split(/\s+/)) {
                if (tok.length >= 3) companyTokenCounts.set(tok, (companyTokenCounts.get(tok) || 0) + 1);
              }
              const name = normalizeName(c.firstName, c.lastName);
              if (name && !nameToCompany.has(name)) nameToCompany.set(name, c.company);
            }
            for (const pn of c.phoneNumbers || []) {
              if (pn.value) {
                mergeContact(pn.value, c);
                mergeContact(normalizeDigits(pn.value), c);
              }
            }
          }
          this.logger.log(`Full sync (live fallback): indexed ${contacts.length} contacts`);
        } catch (e: any) {
          this.logger.warn(`Full sync: contacts fetch failed: ${e?.message}`);
        }
        return;
      }

      for (const s of snapshots) {
        const company = s.providerCompany ?? null;
        const firstName = s.providerFirstName ?? null;
        const lastName = s.providerLastName ?? null;
        if (company) {
          companyValueCounts.set(company, (companyValueCounts.get(company) || 0) + 1);
          for (const tok of company.split(/\s+/)) {
            if (tok.length >= 3) companyTokenCounts.set(tok, (companyTokenCounts.get(tok) || 0) + 1);
          }
          const name = normalizeName(firstName, lastName);
          if (name && !nameToCompany.has(name)) nameToCompany.set(name, company);
        }
        mergeContact(s.phoneE164, { company: company ?? undefined, firstName: firstName ?? undefined, lastName: lastName ?? undefined });
        mergeContact(s.phoneLast10, { company: company ?? undefined, firstName: firstName ?? undefined, lastName: lastName ?? undefined });
      }
      this.logger.log(`Full sync (cache): indexed ${snapshots.length} snapshots (${contactByPhone.size} phone keys, ${companyValueCounts.size} distinct companies, ${nameToCompany.size} named siblings)`);
    })();

    // Fetch conversations for all phone numbers in parallel
    const results = await Promise.allSettled(
      phoneIds.map(pnId =>
        this.openPhoneProvider.getConversations(credentials, undefined, pnId)
          .catch(e => { this.logger.warn(`Failed to fetch conversations for ${pnId}: ${e.message}`); return []; })
      ),
    );

    await contactsPromise;

    // Infer company when defaultFields.company is null:
    //   1. Sibling match — same normalized name ("Stephen Jaros" and "Stephen Jaros cell phone") shares company
    //   2. Full-value match — lastName/firstName exactly equals a known company (2+ contacts have it)
    //   3. Token match — name contains a token that appears in 2+ known company values
    const inferCompany = (c: { company: string | null; firstName: string | null; lastName: string | null } | undefined) => {
      if (!c) return null;
      if (c.company) return c.company;
      const siblingName = normalizeName(c.firstName, c.lastName);
      if (siblingName && nameToCompany.has(siblingName)) return nameToCompany.get(siblingName)!;
      const tryValue = (s: string | null) => (s && companyValueCounts.has(s) && (companyValueCounts.get(s) || 0) >= 2) ? s : null;
      const tryTokens = (s: string | null) => {
        if (!s) return null;
        for (const tok of s.split(/\s+/)) {
          if (tok.length >= 3 && (companyTokenCounts.get(tok) || 0) >= 2) return tok;
        }
        return null;
      };
      return tryValue(c.lastName) || tryValue(c.firstName) || tryTokens(c.lastName) || tryTokens(c.firstName) || null;
    };

    // Prefetch participants for this workspace — used to emit participantId/key + nested provider block.
    // Indexed by normalized last-10 digits (covers any participant phone format discrepancy).
    // Index participants workspace-wide (not tenant-filtered) since /conversations/all
    // itself returns the workspace's live OpenPhone conversations without tenant scoping.
    // Prefer the caller's tenant when the same phone has rows across tenants (ambiguous dedup).
    const participantsByPhone = new Map<string, CommunicationParticipant>();
    if (!usedLiveFallback) {
      const participants = await this.participantRepo.find({
        where: { workspaceId, provider: 'openphone' },
      });
      for (const p of participants) {
        const l10 = last10Digits(p.normalizedPhoneE164);
        if (!l10) continue;
        const existing = participantsByPhone.get(l10);
        if (!existing) {
          participantsByPhone.set(l10, p);
          continue;
        }
        if (tenantId && p.tenantId === tenantId && existing.tenantId !== tenantId) {
          participantsByPhone.set(l10, p);
        }
      }
      this.logger.log(`Full sync (cache): loaded ${participants.length} participants for response join (${participantsByPhone.size} unique phones)`);
    }

    // Merge all conversations
    let allConvs: any[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled' && Array.isArray(result.value)) {
        for (const conv of result.value) {
          const meta = conv.metadata as Record<string, unknown> || {};
          const phoneInfo = phoneNumberMap.get(meta.phoneNumberId as string);
          const participantPhone = conv.participantPhoneNumber || '';
          const opContact = contactByPhone.get(participantPhone)
            || contactByPhone.get(normalizeDigits(participantPhone));

          const { e164: participantE164 } = normalizeToE164(participantPhone);
          const l10 = last10Digits(participantPhone);
          const participant = l10 ? participantsByPhone.get(l10) : undefined;

          const company = inferCompany(opContact);
          const displayName = participant?.providerDisplayName
            ?? resolveDisplayName({
              providerFirstName: opContact?.firstName ?? null,
              providerLastName: opContact?.lastName ?? null,
              providerCompany: company,
            });

          allConvs.push({
            participantPhone,
            phoneNumberId: conv.metadata?.phoneNumberId,
            phoneNumber: conv.phoneNumber || phoneInfo?.number || '',
            phoneNumberName: phoneInfo?.name || '',
            lastMessageAt: conv.lastMessageAt,
            conversationName: conv.metadata?.conversationName,
            contactName: null, // Will be enriched below

            // NEW (PR3) — participant identity
            participantId: participant?.id ?? null,
            participantKey: participant?.participantKey ?? null,
            participantPhoneE164: participantE164 ?? null,

            // NEW (PR3) — nested provider block (forward-compat)
            provider: {
              name: 'openphone',
              accountId: participant?.providerAccountId || phoneInfo?.id || null,
              contactId: participant?.providerContactId ?? null,
              displayName: displayName ?? null,
              company: company ?? null,
            },

            // Legacy flat fields (deprecated, kept for back-compat until SF cuts over)
            company: company ?? null,
            firstName: opContact?.firstName || null,
            lastName: opContact?.lastName || null,

            externalId: conv.externalId,
          });
        }
      }
    }

    // Deduplicate by participant+endpoint
    const seen = new Set<string>();
    allConvs = allConvs.filter(c => {
      const key = `${c.phoneNumber}:${c.participantPhone}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    this.logger.log(`Full sync: ${allConvs.length} unique conversations across ${phoneIds.length} phone numbers`);

    // Enrich with contact names (batch lookup from contacts)
    const numbersToLookup = allConvs
      .filter(c => c.participantPhone && !c.conversationName)
      .map(c => c.participantPhone);

    if (numbersToLookup.length > 0) {
      try {
        const contactNames = await this.openPhoneProvider.lookupContactNamesByPhone(credentials, numbersToLookup);
        for (const conv of allConvs) {
          const name = conv.conversationName || contactNames.get(conv.participantPhone) || null;
          conv.contactName = name;
        }
        this.logger.log(`Full sync: enriched ${contactNames.size} contact names`);
      } catch (e) {
        this.logger.warn(`Full sync: contact name lookup failed: ${e.message}`);
      }
    }

    // Sort by most recent first
    allConvs.sort((a, b) => {
      const aTime = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
      const bTime = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
      return bTime - aTime;
    });

    // Include messages + calls if requested (parallel batch-of-5)
    if (includeMessages) {
      const BATCH_SIZE = 5;
      this.logger.log(`Full sync: fetching messages+calls for ${allConvs.length} conversations (batch-of-${BATCH_SIZE})`);

      for (let i = 0; i < allConvs.length; i += BATCH_SIZE) {
        const batch = allConvs.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.allSettled(
          batch.map(async (conv) => {
            if (!conv.participantPhone || !conv.phoneNumberId) return { messages: [], calls: [] };
            const [msgs, calls] = await Promise.all([
              this.openPhoneProvider.getMessages(credentials, 'live', conv.phoneNumberId, conv.participantPhone)
                .catch(() => []),
              this.openPhoneProvider.getCallsForParticipant(credentials, conv.participantPhone, conv.phoneNumberId)
                .catch(() => []),
            ]);
            return { messages: msgs.slice(0, messageLimit), calls };
          }),
        );
        batchResults.forEach((result, idx) => {
          const data = result.status === 'fulfilled' ? result.value : { messages: [], calls: [] };
          batch[idx].messages = data.messages;
          batch[idx].calls = data.calls;
        });
      }

      const totalMsgs = allConvs.reduce((sum, c) => sum + (c.messages?.length || 0), 0);
      const totalCalls = allConvs.reduce((sum, c) => sum + (c.calls?.length || 0), 0);
      this.logger.log(`Full sync: ${totalMsgs} messages + ${totalCalls} calls`);
    }

    return allConvs;
  }

  /**
   * Get messages for a specific conversation from OpenPhone (live from API)
   */
  async getOpenPhoneMessages(workspaceId: string, phoneNumberId: string, participant: string, tenantId?: string | null): Promise<any[]> {
    // Try tenant-scoped integration first, fall back to workspace-scoped
    let integration = null;
    if (tenantId) {
      integration = await this.tenantIntegrationRepo.findOne({
        where: { workspaceId, tenantId, provider: ProviderType.OPENPHONE },
      });
    }
    if (!integration) {
      integration = await this.integrationRepo.findOne({
        where: { workspaceId, provider: ProviderType.OPENPHONE },
      });
    }
    if (!integration) {
      throw new NotFoundException('OpenPhone integration not found');
    }
    const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);
    const messages = await this.openPhoneProvider.getMessages(credentials, 'live', phoneNumberId, participant);
    return messages;
  }

  /**
   * Bulk lookup contact names by phone numbers using Sigcore's stored contact_identities.
   * Fast DB query — no OpenPhone API pagination needed.
   */
  async lookupContactNamesByPhone(
    workspaceId: string,
    phoneNumbers: string[],
  ): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    if (!phoneNumbers.length) return result;

    // Normalize to last 10 digits for matching
    const normalize = (ph: string) => ph.replace(/\D/g, '').slice(-10);
    const normalizedMap = new Map<string, string>(); // normalized → original
    for (const ph of phoneNumbers) {
      normalizedMap.set(normalize(ph), ph);
    }

    // Query contact_identities by workspace + channel=sms + identity LIKE patterns
    try {
      const identities = await this.contactIdentityRepo
        .createQueryBuilder('ci')
        .where('ci.workspaceId = :workspaceId', { workspaceId })
        .andWhere('ci.display IS NOT NULL')
        .getMany();

      for (const ci of identities) {
        const normalized = normalize(ci.identity);
        const original = normalizedMap.get(normalized);
        if (original && ci.display) {
          result[original] = ci.display;
        }
      }
      this.logger.log(`Contact identity lookup: ${Object.keys(result).length} names from ${identities.length} identities for ${phoneNumbers.length} phones`);
    } catch (e) {
      this.logger.warn(`Contact identity lookup failed: ${e.message}`);
    }

    // Fallback: for phones not found in contact_identities, try OpenPhone live lookup
    const missing = phoneNumbers.filter(ph => !result[ph]);
    if (missing.length > 0) {
      try {
        const integration = await this.integrationRepo.findOne({
          where: { workspaceId, provider: ProviderType.OPENPHONE },
        });
        if (integration) {
          const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);
          const liveNames = await this.openPhoneProvider.lookupContactNamesByPhone(credentials, missing);
          for (const [phone, name] of liveNames) {
            result[phone] = name;
          }
          this.logger.log(`OpenPhone live lookup: ${liveNames.size} additional names for ${missing.length} phones`);
        }
      } catch (e) {
        this.logger.warn(`OpenPhone live lookup failed: ${e.message}`);
      }
    }

    return result;
  }

  /**
   * Update Twilio phone number configuration.
   */
  async updateTwilioPhoneNumber(
    workspaceId: string,
    dto: UpdateTwilioPhoneNumberDto,
  ): Promise<IntegrationInfo> {
    const integration = await this.integrationRepo.findOne({
      where: { workspaceId, provider: ProviderType.TWILIO },
    });

    if (!integration) {
      throw new NotFoundException('Twilio integration not found');
    }

    const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);
    const parsedCredentials = JSON.parse(credentials);

    // Update credentials with new phone number
    parsedCredentials.phoneNumber = dto.phoneNumber;
    parsedCredentials.phoneNumberSid = dto.phoneNumberSid;

    const newCredentials = JSON.stringify(parsedCredentials);
    integration.credentialsEncrypted = this.encryptionService.encrypt(newCredentials);

    // Update metadata
    const metadata = integration.metadata as Record<string, unknown> || {};
    metadata.phoneNumber = dto.phoneNumber;
    metadata.phoneNumberSid = dto.phoneNumberSid;

    // Configure webhooks on the new phone number
    const workspace = await this.workspaceRepo.findOne({
      where: { id: workspaceId },
    });

    if (workspace && dto.phoneNumberSid) {
      const baseUrl = this.getBaseUrl();
      const smsWebhookUrl = `${baseUrl}/api/webhooks/twilio/sms/${workspace.webhookId}`;
      const voiceWebhookUrl = `${baseUrl}/api/webhooks/twilio/voice/${workspace.webhookId}`;

      const webhookResult = await this.twilioProvider.configureWebhooks(
        newCredentials,
        dto.phoneNumberSid,
        smsWebhookUrl,
        voiceWebhookUrl,
      );

      metadata.smsWebhookConfigured = webhookResult.success;
      metadata.voiceWebhookConfigured = webhookResult.success;
      if (webhookResult.success) {
        metadata.webhooksConfiguredAt = new Date().toISOString();
      }
    }

    integration.metadata = metadata;
    await this.integrationRepo.save(integration);

    return this.getIntegration(workspaceId, ProviderType.TWILIO) as Promise<IntegrationInfo>;
  }

  /**
   * Delete integration by provider.
   * Returns a result object instead of throwing on not-found,
   * so callers (like Callio) always get a JSON response.
   */
  async deleteIntegration(workspaceId: string, provider?: ProviderType): Promise<{ success: boolean; error?: string }> {
    const whereClause: { workspaceId: string; provider?: ProviderType } = { workspaceId };
    if (provider) {
      whereClause.provider = provider;
    }

    const integration = await this.integrationRepo.findOne({
      where: whereClause,
    });

    if (!integration) {
      this.logger.log(`No integration found for workspace ${workspaceId} (provider=${provider || 'any'}) — nothing to delete`);
      return { success: true }; // Idempotent: already deleted is still success
    }

    // Delete webhooks based on provider
    if (integration.provider === ProviderType.OPENPHONE && integration.metadata) {
      const metadata = integration.metadata as { messageWebhookId?: string; callWebhookId?: string };
      if (metadata.messageWebhookId || metadata.callWebhookId) {
        try {
          const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);
          await this.openPhoneProvider.deleteWebhooks(credentials, {
            messageWebhookId: metadata.messageWebhookId,
            callWebhookId: metadata.callWebhookId,
          });
          this.logger.log(`Deleted OpenPhone webhooks for workspace ${workspaceId}`);
        } catch (error) {
          this.logger.warn(`Failed to delete OpenPhone webhooks for workspace ${workspaceId}`, error);
        }
      }
    }
    // Note: For Twilio, webhooks are configured on the phone number and will remain until the number is released

    await this.integrationRepo.remove(integration);
    this.logger.log(`Deleted ${integration.provider} integration for workspace ${workspaceId}`);
    return { success: true };
  }

  async getWebhookSecret(workspaceId: string, provider?: ProviderType): Promise<string | null> {
    const whereClause: { workspaceId: string; provider?: ProviderType } = { workspaceId };
    if (provider) {
      whereClause.provider = provider;
    }

    const integration = await this.integrationRepo.findOne({
      where: whereClause,
    });

    if (!integration?.webhookSecretEncrypted) {
      return null;
    }

    return this.encryptionService.decrypt(integration.webhookSecretEncrypted);
  }

  async getDecryptedCredentials(workspaceId: string, provider?: ProviderType): Promise<Record<string, unknown> | null> {
    const whereClause: { workspaceId: string; provider?: ProviderType } = { workspaceId };
    if (provider) {
      whereClause.provider = provider;
    }

    const integration = await this.integrationRepo.findOne({
      where: whereClause,
    });

    if (!integration) {
      return null;
    }

    const decrypted = this.encryptionService.decrypt(integration.credentialsEncrypted);
    return JSON.parse(decrypted);
  }

  // ==================== TWILIO VOICE ====================

  async generateTwilioVoiceToken(
    workspaceId: string,
    userId?: string,
  ): Promise<string> {
    this.logger.log(`========== GENERATE VOICE TOKEN START ==========`);
    this.logger.log(`Workspace ID: ${workspaceId}`);
    // Legacy path (no userId) is supported — log it so ops can track
    // consumers that haven't migrated yet.
    this.logger.log(`User ID: ${userId ?? '(legacy — none)'}`);

    const workspace = await this.ensureWorkspace(workspaceId);
    this.logger.log(`Found workspace: ${workspace.name}`);

    // Post-Wave-2, a workspace may hold TWO Twilio integrations:
    //   - workspace-scoped (owner_tenant_id IS NULL) — the LB shared row
    //   - tenant-scoped (owner_tenant_id = X)        — the Callio row
    // Voice SDK credentials (voiceApiKey/Secret/TwimlAppSid) live on the
    // TENANT-scoped row (provisioned via POST /integrations/:id/provision-
    // voice). Prefer the tenant-scoped row so voice-token minting doesn't
    // pick up the workspace-scoped LB row which never has voice creds.
    // Fall back to workspace-scoped for pre-Wave-2 workspaces where the
    // only integration is the legacy shared one.
    //
    // Same shape as the `ensureIntegration` fix from Incident 2026-07-14
    // Phase 5a (commit e203b1b) — established pattern.
    let integration = await this.integrationRepo
      .createQueryBuilder('i')
      .where('i.workspace_id = :workspaceId', { workspaceId })
      .andWhere('i.provider = :provider', { provider: ProviderType.TWILIO })
      .andWhere('i.status = :status', { status: IntegrationStatus.ACTIVE })
      .andWhere('i.owner_tenant_id IS NOT NULL')
      .orderBy('i.created_at', 'DESC')
      .getOne();
    if (!integration) {
      integration = await this.integrationRepo.findOne({
        where: {
          workspaceId,
          provider: ProviderType.TWILIO,
          status: IntegrationStatus.ACTIVE,
        },
      });
    }

    if (!integration) {
      this.logger.error(`Twilio integration not found for workspace ${workspaceId}`);
      throw new NotFoundException('Twilio integration not found');
    }

    this.logger.log(`Found Twilio integration: ${integration.id}, status: ${integration.status}`);

    // Decrypt and parse credentials
    const decrypted = this.encryptionService.decrypt(integration.credentialsEncrypted);
    const credentials = JSON.parse(decrypted);

    this.logger.log(`Credentials decrypted. Checking voice credentials...`);
    this.logger.log(`- Has voiceApiKey: ${!!credentials.voiceApiKey}`);
    this.logger.log(`- Has voiceApiSecret: ${!!credentials.voiceApiSecret}`);
    this.logger.log(`- Has voiceTwimlAppSid: ${!!credentials.voiceTwimlAppSid}`);
    this.logger.log(`- Account SID: ${credentials.accountSid?.substring(0, 10)}...`);

    if (!credentials.voiceApiKey || !credentials.voiceApiSecret || !credentials.voiceTwimlAppSid) {
      this.logger.error('Voice credentials missing!');
      throw new BadRequestException('Twilio Voice credentials not configured. Please reconnect your Twilio account.');
    }

    // Encode via VoiceIdentity so the wire format stays behind one abstraction
    // — extra fields (clientType / deviceId) can be added at call sites today
    // without requiring a format change here.
    const identity = VoiceIdentity.encode({ workspaceId: workspace.id, userId });
    this.logger.log(
      `Generating access token for identity: ${identity} (${
        userId ? 'per-user' : 'legacy workspace-only'
      })`,
    );
    const token = this.twilioVoiceService.generateAccessToken(
      identity,
      credentials.accountSid,
      credentials.voiceApiKey,
      credentials.voiceApiSecret,
      credentials.voiceTwimlAppSid,
    );

    this.logger.log(`Token generated successfully (length: ${token.length} chars)`);
    this.logger.log(`========== GENERATE VOICE TOKEN END ==========`);

    return token;
  }

  async generateOutgoingCallTwiML(
    workspaceId: string,
    to: string,
    from: string,
    callerId?: string,
  ): Promise<string> {
    // Defensive check on the admin `/integrations/twilio/voice/twiml`
    // endpoint. The TwiML App actually hits `handleOutgoingCall` for browser
    // calls (which is where the primary enforcement lives), but this
    // endpoint is exposed on the API surface too and must not be a bypass.
    // Same resolver-driven ownership rules apply.
    const effectiveCallerId = callerId ?? from;
    const enforcement =
      (this.configService.get<string>(
        'SIGCORE_VOICE_CALLER_ID_ENFORCEMENT',
      ) ?? 'on').toLowerCase();
    const enforce = enforcement !== 'off';

    if (this.providerContextResolver) {
      let ownedByNumber = false;
      try {
        const context = await this.providerContextResolver.resolve({
          workspaceId,
          provider: ProviderType.TWILIO,
          fromNumber: effectiveCallerId,
        });
        ownedByNumber = context.rule === 'by_number';
      } catch {
        ownedByNumber = false;
      }
      if (!ownedByNumber) {
        this.logger.warn(
          `[CALLER-ID REJECT] admin-twiml workspace=${workspaceId} callerId=${effectiveCallerId} to=${to} enforce=${enforce}`,
        );
        if (enforce) {
          throw new BadRequestException(
            `Caller ID ${effectiveCallerId} is not an owned phone number for this workspace`,
          );
        }
      }
    }
    return this.twilioVoiceService.generateOutgoingCallTwiML(to, from, callerId);
  }

  async getTwilioVoiceConfig(workspaceId: string): Promise<{
    twimlAppSid: string;
    currentWebhookUrl: string;
    expectedWebhookUrl: string;
    isConfigured: boolean;
  }> {
    this.logger.log(`========== GET VOICE CONFIG START ==========`);
    this.logger.log(`Workspace ID: ${workspaceId}`);

    const workspace = await this.ensureWorkspace(workspaceId);

    const integration = await this.integrationRepo.findOne({
      where: {
        workspaceId,
        provider: ProviderType.TWILIO,
        status: IntegrationStatus.ACTIVE,
      },
    });

    if (!integration) {
      throw new NotFoundException('Twilio integration not found');
    }

    const decrypted = this.encryptionService.decrypt(integration.credentialsEncrypted);
    const credentials = JSON.parse(decrypted);

    const baseUrl = this.getBaseUrl();
    const expectedWebhookUrl = `${baseUrl}/api/webhooks/twilio/voice/${workspace.webhookId}`;

    // Get current webhook URL from Twilio
    let currentWebhookUrl = '';
    let isConfigured = false;

    try {
      const result = await this.twilioProvider.getTwiMLAppConfig(
        JSON.stringify(credentials),
        credentials.voiceTwimlAppSid,
      );

      if (result.success && result.config) {
        currentWebhookUrl = result.config.voiceUrl;
        isConfigured = currentWebhookUrl === expectedWebhookUrl;
      }
    } catch (error) {
      this.logger.error('Failed to get TwiML App config from Twilio', error);
    }

    this.logger.log(`TwiML App SID: ${credentials.voiceTwimlAppSid}`);
    this.logger.log(`Current webhook URL: ${currentWebhookUrl}`);
    this.logger.log(`Expected webhook URL: ${expectedWebhookUrl}`);
    this.logger.log(`Is configured correctly: ${isConfigured}`);
    this.logger.log(`========== GET VOICE CONFIG END ==========`);

    return {
      twimlAppSid: credentials.voiceTwimlAppSid,
      currentWebhookUrl,
      expectedWebhookUrl,
      isConfigured,
    };
  }

  // ==================== TENANT-SCOPED OPENPHONE METHODS ====================

  /**
   * Connect (or update) an OpenPhone integration for a specific tenant.
   * Validates the API key, then upserts a TenantIntegration record.
   */
  async connectOpenPhoneForTenant(
    workspaceId: string,
    tenantId: string,
    apiKey: string,
  ): Promise<TenantIntegration> {
    const credentials = JSON.stringify({ apiKey });
    const isValid = await this.openPhoneProvider.validateCredentials(credentials);
    if (!isValid) {
      throw new BadRequestException('Invalid OpenPhone API key');
    }

    const encryptedCredentials = this.encryptionService.encrypt(credentials);

    let integration = await this.tenantIntegrationRepo.findOne({
      where: { workspaceId, tenantId, provider: ProviderType.OPENPHONE },
    });

    if (integration) {
      integration.credentialsEncrypted = encryptedCredentials;
      integration.status = IntegrationStatus.ACTIVE;
    } else {
      integration = this.tenantIntegrationRepo.create({
        workspaceId,
        tenantId,
        provider: ProviderType.OPENPHONE,
        credentialsEncrypted: encryptedCredentials,
        status: IntegrationStatus.ACTIVE,
      });
    }

    await this.tenantIntegrationRepo.save(integration);
    this.logger.log(`Connected OpenPhone for tenant ${tenantId} in workspace ${workspaceId}`);

    // Register the discovered OpenPhone workspace numbers as tenant-owned so
    // /api/conversations phone-ownership scoping (PR #48) can route inbound
    // Quo conversations back to this tenant. Prior to this step, LB stored
    // connectedNumbers locally but Sigcore had no tenant_phone_numbers row
    // for them — every OpenPhone conversation was invisible via /conversations
    // (Klaus Woodward 2026-08-10). Best-effort: any error registering phones
    // must NOT fail the connect itself (credentials are already saved).
    try {
      await this.registerOpenPhoneNumbersForTenant(workspaceId, tenantId, credentials);
    } catch (err: any) {
      this.logger.warn(
        `[connectOpenPhoneForTenant] phone-registration failed for tenant ${tenantId}: ${err?.message ?? err} — credentials saved, /conversations may 404 until re-registered`,
      );
    }

    return integration;
  }

  /**
   * Register every phone number in the caller's OpenPhone workspace as a
   * tenant-owned TenantPhoneNumber row. Idempotent — existing rows on the
   * same tenant get their provider metadata refreshed; rows owned by a
   * DIFFERENT tenant in the same workspace are skipped with a warn (we
   * never steal ownership). Called from connectOpenPhoneForTenant and
   * from a companion backfill script that walks existing
   * TenantIntegration rows.
   */
  async registerOpenPhoneNumbersForTenant(
    workspaceId: string,
    tenantId: string,
    credentials: string,
  ): Promise<{ registered: number; refreshed: number; conflicted: number }> {
    const phoneMap = await this.openPhoneProvider.getPhoneNumbersFromCredentials(credentials);
    const phones = Array.from(phoneMap.values());
    let registered = 0, refreshed = 0, conflicted = 0;

    for (const pn of phones) {
      const phoneNumber = pn.number;
      if (!phoneNumber) continue;

      const existing = await this.tenantPhoneRepo.findOne({
        where: { workspaceId, phoneNumber },
      });

      if (existing) {
        if (existing.tenantId !== tenantId) {
          this.logger.warn(
            `[registerOpenPhoneNumbersForTenant] phone ${phoneNumber} in workspace ${workspaceId} already owned by tenant ${existing.tenantId} — skipping (would not overwrite to ${tenantId})`,
          );
          conflicted++;
          continue;
        }
        // Same tenant → refresh provider metadata so friendlyName / providerId
        // stay in sync with OpenPhone-side edits. Preserve everything else
        // (isDefault, channel, metadata, provisioning state).
        existing.provider = PhoneNumberProvider.OPENPHONE;
        existing.providerId = pn.id ?? existing.providerId;
        existing.friendlyName = pn.name ?? existing.friendlyName;
        existing.status = PhoneNumberAllocationStatus.ACTIVE;
        await this.tenantPhoneRepo.save(existing);
        refreshed++;
        continue;
      }

      // OpenPhone numbers support both SMS + voice by default. The schema's
      // single `channel` column can't express both, so we store 'sms' as
      // primary (matches Twilio 'both' allocation convention) and record
      // capabilities in metadata for consumers that need the fuller picture.
      const allocation = this.tenantPhoneRepo.create({
        workspaceId,
        tenantId,
        phoneNumber,
        friendlyName: pn.name,
        provider: PhoneNumberProvider.OPENPHONE,
        providerId: pn.id,
        channel: ChannelType.SMS,
        status: PhoneNumberAllocationStatus.ACTIVE,
        isDefault: false,
        metadata: {
          activeChannels: ['sms', 'voice'],
          openPhoneCapabilities: pn.capabilities ?? null,
        },
      });
      await this.tenantPhoneRepo.save(allocation);
      registered++;
    }

    this.logger.log(
      `[registerOpenPhoneNumbersForTenant] tenant=${tenantId} workspace=${workspaceId} registered=${registered} refreshed=${refreshed} conflicted=${conflicted} of ${phones.length} phones`,
    );
    return { registered, refreshed, conflicted };
  }

  /**
   * Get OpenPhone phone numbers for a specific tenant.
   */
  async getOpenPhoneNumbersForTenant(
    workspaceId: string,
    tenantId: string,
  ): Promise<Array<{ id: string; number: string; name?: string; capabilities?: { sms: boolean; voice: boolean; mms: boolean } }>> {
    const integration = await this.tenantIntegrationRepo.findOne({
      where: { workspaceId, tenantId, provider: ProviderType.OPENPHONE },
    });

    if (!integration) {
      throw new NotFoundException('OpenPhone integration not found for this tenant');
    }

    const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);
    const phoneNumberMap = await this.openPhoneProvider.getPhoneNumbersFromCredentials(credentials);

    return Array.from(phoneNumberMap.values()).map((pn) => ({
      id: pn.id,
      number: pn.number,
      name: pn.name,
      symbol: pn.symbol || null,
      capabilities: pn.capabilities,
    }));
  }

  /**
   * Disconnect (delete) the OpenPhone integration for a specific tenant.
   *
   * Mirrors the cleanup in workspace-scoped `deleteIntegration` (above):
   * if the integration's metadata holds OpenPhone webhook IDs, attempt to
   * delete them in OpenPhone before removing the row. Best-effort — a
   * webhook-delete failure must not block the local row removal, otherwise
   * a partially-broken OpenPhone-side state would leave the tenant unable
   * to disconnect at all.
   *
   * Today, `connectOpenPhoneForTenant` does not register tenant-scoped
   * webhooks (the workspace-level webhook URL is reused with tenant routing
   * resolved server-side from the inbound payload). The current production
   * state therefore has zero webhook IDs to clean up. This defensive
   * cleanup is structural symmetry with the workspace path and forward-
   * compatible with any future flow that does register per-tenant webhooks.
   * Readiness-report Fix C, 2026-05-08.
   */
  async disconnectOpenPhoneForTenant(
    workspaceId: string,
    tenantId: string,
  ): Promise<{ success: boolean }> {
    const integration = await this.tenantIntegrationRepo.findOne({
      where: { workspaceId, tenantId, provider: ProviderType.OPENPHONE },
    });

    if (!integration) {
      this.logger.log(`No OpenPhone integration found for tenant ${tenantId} — nothing to delete`);
      return { success: true };
    }

    if (integration.metadata) {
      const metadata = integration.metadata as { messageWebhookId?: string; callWebhookId?: string };
      if (metadata.messageWebhookId || metadata.callWebhookId) {
        try {
          const credentials = this.encryptionService.decrypt(integration.credentialsEncrypted);
          await this.openPhoneProvider.deleteWebhooks(credentials, {
            messageWebhookId: metadata.messageWebhookId,
            callWebhookId: metadata.callWebhookId,
          });
          this.logger.log(
            `Deleted OpenPhone webhooks for tenant ${tenantId} in workspace ${workspaceId}`,
          );
        } catch (error) {
          this.logger.warn(
            `Failed to delete OpenPhone webhooks for tenant ${tenantId} in workspace ${workspaceId}; ` +
              `proceeding with local row removal anyway`,
            error,
          );
        }
      }
    }

    await this.tenantIntegrationRepo.remove(integration);
    this.logger.log(`Disconnected OpenPhone for tenant ${tenantId} in workspace ${workspaceId}`);
    return { success: true };
  }

  async refreshTwilioVoiceWebhook(workspaceId: string): Promise<{
    success: boolean;
    twimlAppSid: string;
    webhookUrl: string;
  }> {
    this.logger.log(`========== REFRESH VOICE WEBHOOK START ==========`);
    this.logger.log(`Workspace ID: ${workspaceId}`);

    const workspace = await this.ensureWorkspace(workspaceId);

    const integration = await this.integrationRepo.findOne({
      where: {
        workspaceId,
        provider: ProviderType.TWILIO,
        status: IntegrationStatus.ACTIVE,
      },
    });

    if (!integration) {
      throw new NotFoundException('Twilio integration not found');
    }

    const decrypted = this.encryptionService.decrypt(integration.credentialsEncrypted);
    const credentials = JSON.parse(decrypted);

    const baseUrl = this.getBaseUrl();
    const voiceWebhookUrl = `${baseUrl}/api/webhooks/twilio/voice/${workspace.webhookId}`;

    this.logger.log(`Updating TwiML App ${credentials.voiceTwimlAppSid} webhook to: ${voiceWebhookUrl}`);

    // Update the TwiML App webhook URL
    const result = await this.twilioProvider.createTwiMLApp(
      JSON.stringify(credentials),
      `Callio Voice - ${workspace.name || workspaceId}`,
      voiceWebhookUrl,
    );

    if (!result.success) {
      this.logger.error(`Failed to update TwiML App webhook: ${result.error}`);
      throw new BadRequestException(`Failed to update webhook: ${result.error}`);
    }

    this.logger.log(`✅ TwiML App webhook updated successfully`);
    this.logger.log(`========== REFRESH VOICE WEBHOOK END ==========`);

    return {
      success: true,
      twimlAppSid: credentials.voiceTwimlAppSid,
      webhookUrl: voiceWebhookUrl,
    };
  }
}

/**
 * Wave-2 Task 6B.5A — shape an integration row into the ensure response,
 * mapping NULL operational_status to `ready` for grandfathered pre-6B.5A
 * rows so the pilot continues to report unchanged.
 */
function toEnsureResult(
  row: CommunicationIntegration,
  created: boolean,
  workspaceId: string,
  tenantId: string,
): EnsureIntegrationResult {
  return {
    id: row.id,
    created,
    workspaceId,
    tenantId,
    provider: row.provider,
    operationalStatus: row.operationalStatus ?? OperationalStatus.READY,
    operationalReason: row.operationalReason ?? null,
  };
}
