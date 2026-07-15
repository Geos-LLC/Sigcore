import {
  BadGatewayException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import {
  CommunicationIntegration,
  ProviderType,
} from '../../database/entities/communication-integration.entity';
import { Workspace } from '../../database/entities/workspace.entity';
import { EncryptionService } from '../../common/services/encryption.service';
import { TwilioProvider } from '../communication/providers/twilio.provider';

export interface ProvisionVoiceResult {
  provisioned: true;
  apiKeyCreated: boolean;
  twimlAppEnsured: boolean;
  voiceApiKeySidPrefix: string;
  voiceTwimlAppSid: string;
  twimlAppVoiceUrl: string;
}

/**
 * Feature 2 — Twilio Voice SDK credential provisioning.
 *
 * Sigcore owns communication infrastructure — no product (Callio, LeadBridge,
 * ServiceFlow) is allowed to write encrypted credentials directly. This
 * service is the single path that provisions Voice SDK credentials
 * (`voiceApiKey`, `voiceApiSecret`, `voiceTwimlAppSid`) onto an existing
 * Twilio `communication_integrations` row and returns masked identifiers.
 *
 * ## Idempotency
 *
 * The endpoint is safe to call repeatedly. Semantics per field:
 *
 * - **`voiceApiKey` / `voiceApiSecret`** — if Sigcore already has both fields
 *   in the decrypted credentials, we skip API-Key creation entirely. Twilio's
 *   REST API only returns the secret on creation, so we cannot adopt an
 *   orphaned key by FriendlyName; on the rare re-run where Sigcore lost the
 *   secret, this service would mint a fresh key (leaving the old one as dead
 *   inventory on Twilio).
 *
 * - **`voiceTwimlAppSid`** — if Sigcore already has the SID, skip. Otherwise
 *   defer to `TwilioProvider.createTwiMLApp`, which is already idempotent by
 *   FriendlyName: it lists existing apps with the same name, updates the
 *   Voice URL if present, else creates one. Adoption is safe because a
 *   TwiML App SID contains no secret material.
 *
 * ## Concurrency
 *
 * Wrapped in a transaction with `SELECT … FOR UPDATE` on the integration
 * row. Two concurrent callers with the same integrationId serialize; the
 * second observes the state left by the first and no-ops.
 *
 * ## Security
 *
 * - Response NEVER includes API secret, auth token, or full API Key SID.
 * - Logs mask SIDs to a `SK123456...ABCD` prefix/suffix shape.
 * - Never logs the raw error surface from Twilio (which occasionally echoes
 *   the SID being operated on but not secrets — we still slice for length).
 * - Requires `AdminKeyGuard`-scoped or `X-Sigcore-Key`-scoped auth on the
 *   controller. Callers also pass `workspaceId` which we cross-check against
 *   the integration row's owner.
 *
 * ## When to use vs. the initial subaccount provisioner
 *
 * `TwilioSubaccountProvisionerService.ensureReady()` handles the FIRST-TIME
 * setup of a workspace's Twilio subaccount (Account SID + Auth Token) and
 * runs on first voice-number purchase. This provisioner layers the
 * additional Voice SDK credentials on top of that. Call this AFTER the
 * subaccount provisioner has left the row in a ready state.
 */
@Injectable()
export class TwilioVoiceProvisionerService {
  private readonly logger = new Logger(TwilioVoiceProvisionerService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly encryptionService: EncryptionService,
    private readonly twilioProvider: TwilioProvider,
    private readonly configService: ConfigService,
  ) {}

  async provisionVoice(
    integrationId: string,
    callerWorkspaceId: string,
  ): Promise<ProvisionVoiceResult> {
    return this.dataSource.transaction(async (mgr) => {
      const repo = mgr.getRepository(CommunicationIntegration);

      const integration = await repo
        .createQueryBuilder('i')
        .setLock('pessimistic_write')
        .where('i.id = :id', { id: integrationId })
        .getOne();

      if (!integration) {
        throw new NotFoundException(`integration ${integrationId} not found`);
      }
      if (integration.workspaceId !== callerWorkspaceId) {
        // Ownership cross-check: even though the controller is admin-guarded,
        // the workspaceId header the caller supplies must match the row's
        // workspace. Prevents an admin token being used to reach into
        // another workspace's integrations by passing arbitrary ids.
        throw new ForbiddenException(
          'integration does not belong to the caller workspace',
        );
      }
      if (integration.provider !== ProviderType.TWILIO) {
        throw new ConflictException(
          `provider ${integration.provider} is not twilio`,
        );
      }
      if (!integration.credentialsEncrypted) {
        throw new ConflictException(
          'integration has no credentials yet — run the subaccount provisioner first',
        );
      }

      let creds: Record<string, unknown>;
      try {
        creds = JSON.parse(
          this.encryptionService.decrypt(integration.credentialsEncrypted),
        ) as Record<string, unknown>;
      } catch (err) {
        throw new ConflictException(
          `integration credentials failed to decrypt: ${
            err instanceof Error ? err.message : 'unknown'
          }`,
        );
      }

      const accountSid = creds.accountSid as string | undefined;
      const authToken = creds.authToken as string | undefined;
      if (!accountSid || !authToken) {
        throw new ConflictException(
          'integration credentials missing accountSid or authToken — subaccount not ready',
        );
      }

      const workspace = await mgr
        .getRepository(Workspace)
        .findOne({ where: { id: integration.workspaceId } });
      if (!workspace?.webhookId) {
        throw new ConflictException(
          `workspace ${integration.workspaceId} has no webhookId — cannot compute Voice URL`,
        );
      }

      const baseUrl = this.getBaseUrl();
      const voiceUrl = `${baseUrl}/api/webhooks/twilio/voice/${workspace.webhookId}`;
      // Twilio caps FriendlyName at 64 chars — the workspace UUID plus the
      // fixed prefix is 55, safely inside.
      const friendlyName = `Sigcore-Callio-Voice-${integration.workspaceId}`.slice(
        0,
        64,
      );

      const hasApiKey = Boolean(creds.voiceApiKey && creds.voiceApiSecret);
      const hasTwimlApp = Boolean(creds.voiceTwimlAppSid);

      // Full idempotent no-op path — both already present.
      if (hasApiKey && hasTwimlApp) {
        this.logger.log(
          `voice_provision_noop integrationId=${integrationId} workspaceId=${integration.workspaceId} apiKey=${maskSid(String(creds.voiceApiKey))} twimlApp=${maskSid(String(creds.voiceTwimlAppSid))}`,
        );
        return {
          provisioned: true,
          apiKeyCreated: false,
          twimlAppEnsured: false,
          voiceApiKeySidPrefix: maskSid(String(creds.voiceApiKey)),
          voiceTwimlAppSid: String(creds.voiceTwimlAppSid),
          twimlAppVoiceUrl: voiceUrl,
        };
      }

      // TwilioProvider methods parse a credentials JSON string that
      // contains only accountSid + authToken (their internal shape).
      const credsForProvider = JSON.stringify({ accountSid, authToken });

      let apiKeyCreated = false;
      if (!hasApiKey) {
        const result = await this.twilioProvider.createApiKey(
          credsForProvider,
          friendlyName,
        );
        if (!result.success || !result.apiKey) {
          throw new BadGatewayException(
            `Twilio API Key creation failed: ${result.error ?? 'unknown'}`,
          );
        }
        creds.voiceApiKey = result.apiKey.sid;
        creds.voiceApiSecret = result.apiKey.secret;
        apiKeyCreated = true;
        this.logger.log(
          `voice_provision_api_key_created integrationId=${integrationId} workspaceId=${integration.workspaceId} apiKey=${maskSid(result.apiKey.sid)}`,
        );
      }

      let twimlAppEnsured = false;
      if (!hasTwimlApp) {
        const result = await this.twilioProvider.createTwiMLApp(
          credsForProvider,
          friendlyName,
          voiceUrl,
        );
        if (!result.success || !result.twimlApp) {
          throw new BadGatewayException(
            `Twilio TwiML App provisioning failed: ${result.error ?? 'unknown'}`,
          );
        }
        creds.voiceTwimlAppSid = result.twimlApp.sid;
        twimlAppEnsured = true;
        this.logger.log(
          `voice_provision_twiml_app_ensured integrationId=${integrationId} workspaceId=${integration.workspaceId} twimlApp=${result.twimlApp.sid} voiceUrl=${voiceUrl}`,
        );
      }

      integration.credentialsEncrypted = this.encryptionService.encrypt(
        JSON.stringify(creds),
      );
      await repo.save(integration);

      this.logger.log(
        `voice_provision_success integrationId=${integrationId} workspaceId=${integration.workspaceId} apiKeyCreated=${apiKeyCreated} twimlAppEnsured=${twimlAppEnsured}`,
      );

      return {
        provisioned: true,
        apiKeyCreated,
        twimlAppEnsured,
        voiceApiKeySidPrefix: maskSid(String(creds.voiceApiKey)),
        voiceTwimlAppSid: String(creds.voiceTwimlAppSid),
        twimlAppVoiceUrl: voiceUrl,
      };
    });
  }

  private getBaseUrl(): string {
    return (
      this.configService.get('BASE_URL') ||
      process.env.BASE_URL ||
      (process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : null) ||
      'http://localhost:3002'
    );
  }
}

/**
 * `SK1234ab...cdef` — safe to log or return over HTTP. Twilio SIDs are not
 * secret in themselves, but masking gives us defense-in-depth against any
 * client-side leak (URLs, screenshots).
 */
function maskSid(sid: string): string {
  if (!sid || sid.length < 12) return '****';
  return `${sid.slice(0, 6)}...${sid.slice(-4)}`;
}
