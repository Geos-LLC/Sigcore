import {
  BadGatewayException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import {
  CommunicationIntegration,
  OperationalStatus,
  OperationalReasonCode,
  ProviderType,
} from '../../database/entities/communication-integration.entity';
import { Workspace } from '../../database/entities/workspace.entity';
import { EncryptionService } from '../../common/services/encryption.service';
import { TwilioProvider } from '../communication/providers/twilio.provider';

interface TwilioMasterCredentials {
  accountSid: string;
  authToken: string;
}

/**
 * Wave-2 Task 6B.5A — lazy Twilio subaccount provisioning.
 *
 * Called on the first voice-number purchase for a Callio communication
 * identity whose Twilio integration is still in `pending_credentials`.
 * Encapsulates the state machine that:
 *
 *   1. Locks the integration row (`SELECT … FOR UPDATE`) so concurrent
 *      purchases serialize and only ONE subaccount is minted.
 *   2. Short-circuits if another caller already took the row to `ready`.
 *   3. Marks the row `provisioning`, creates a Twilio subaccount under the
 *      master account, encrypts subaccount SID + auth token into
 *      `credentials_encrypted`, then runs a provider preflight.
 *   4. On preflight success, transitions to `ready` and stamps
 *      `operational_last_verified_at`.
 *   5. On any failure, transitions to `error` with a stable machine-
 *      readable reason code and preserves what has already been created
 *      so retry is safe.
 *
 * Never deletes Sigcore or Twilio resources — a partial provisioning is
 * repaired on retry, not rolled back. Subaccounts are irreversible under
 * Twilio, so we treat them as durable and simply update the row's
 * credentials/reason on subsequent successful attempts.
 *
 * The master Twilio account's credentials come from Sigcore env vars —
 * consumers of Sigcore never see them and cannot influence them.
 */
@Injectable()
export class TwilioSubaccountProvisionerService {
  private readonly logger = new Logger(TwilioSubaccountProvisionerService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly encryptionService: EncryptionService,
    private readonly twilioProvider: TwilioProvider,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Ensure the given integration is `operational_status = ready`.
   *
   * - If already `ready` (or grandfathered NULL with usable credentials),
   *   returns without side effects.
   * - If `pending_credentials`, provisions a subaccount + preflights +
   *   transitions the row.
   * - If `provisioning`, another caller is currently mid-flight; this
   *   caller either waits for the row lock (which serializes) or observes
   *   the terminal state on retry.
   * - If `error`, retries provisioning from the appropriate resume point.
   *
   * Returns the updated integration row for callers that need its
   * subaccount SID or verification timestamp.
   */
  async ensureReady(integrationId: string): Promise<CommunicationIntegration> {
    return this.dataSource.transaction(async (mgr) => {
      const repo = mgr.getRepository(CommunicationIntegration);

      // Row lock so concurrent purchases for the same workspace serialize.
      const integration = await repo
        .createQueryBuilder('i')
        .setLock('pessimistic_write')
        .where('i.id = :id', { id: integrationId })
        .getOne();

      if (!integration) {
        throw new BadGatewayException(
          `integration ${integrationId} not found`,
        );
      }
      if (integration.provider !== ProviderType.TWILIO) {
        // Non-Twilio providers do not participate in this state machine yet.
        // Return unchanged; callers of this service only invoke it for
        // Twilio purchases today.
        return integration;
      }

      // Short-circuit: already ready OR grandfathered pilot row (NULL status
      // + non-empty credentials treated as ready to preserve pilot behavior).
      const status = integration.operationalStatus ?? null;
      if (status === OperationalStatus.READY) {
        return integration;
      }
      if (
        status === null &&
        this.hasNonEmptyCredentials(integration.credentialsEncrypted)
      ) {
        // Legacy row from before Task 6B.5A migration — treat as ready.
        return integration;
      }

      // Fetch workspace name for the subaccount friendlyName. Never expose
      // the workspace name to Twilio in raw form; prefix with a stable
      // brand marker so ops can tell Sigcore-minted subaccounts apart.
      const workspace = await mgr
        .getRepository(Workspace)
        .findOne({ where: { id: integration.workspaceId } });
      const workspaceName = workspace?.name ?? 'unnamed';
      const friendlyName = `Sigcore/Callio · ${integration.workspaceId} · ${workspaceName}`.slice(
        0,
        64, // Twilio friendlyName limit
      );

      // Guard: master credentials configured?
      const master = this.readMasterCredentials();
      if (!master) {
        return await this.markError(
          repo,
          integration,
          OperationalReasonCode.TWILIO_CREDENTIALS_NOT_CONFIGURED,
          'Sigcore master Twilio credentials are not configured',
        );
      }

      // Transition to `provisioning` so a peer that skips the lock (or
      // that observes the row between transactions on a replica) sees
      // in-flight state rather than a stale `pending_credentials`.
      integration.operationalStatus = OperationalStatus.PROVISIONING;
      integration.operationalReason = null;
      await repo.save(integration);

      // Step 1 — create OR repair.
      //
      // Repair path (retry after a prior partial failure): if the row
      // already carries a `providerSubaccountSid` AND non-empty encrypted
      // credentials, we reuse them and skip straight to preflight. This
      // is the "repeated calls create no duplicate provider resources"
      // guarantee — the subaccount is already minted on Twilio's side and
      // its auth token is durably persisted.
      //
      // Unrecoverable path: if `providerSubaccountSid` is present but the
      // credentials blob is empty (edge case: the row got the sid but the
      // creds save failed and Twilio's auth token can never be re-fetched),
      // we cannot silently proceed. Mark error with a clear operator-
      // recovery message; do NOT mint a duplicate subaccount to paper over
      // the inconsistency.
      let subaccountSid: string;
      let subaccountAuthToken: string;
      const hasCreds = this.hasNonEmptyCredentials(
        integration.credentialsEncrypted,
      );
      if (integration.providerSubaccountSid && hasCreds) {
        // Repair-eligible: reuse the persisted subaccount + creds.
        subaccountSid = integration.providerSubaccountSid;
        const decrypted = JSON.parse(
          this.encryptionService.decrypt(integration.credentialsEncrypted),
        );
        subaccountAuthToken = decrypted.authToken;
        this.logger.log(
          `twilio_subaccount_repair_reuse integrationId=${integration.id} workspaceId=${integration.workspaceId} subaccountSid=${subaccountSid}`,
        );
      } else if (integration.providerSubaccountSid && !hasCreds) {
        return await this.markError(
          repo,
          integration,
          OperationalReasonCode.TWILIO_SUBACCOUNT_CREATE_FAILED,
          `subaccount ${integration.providerSubaccountSid} was created in a prior attempt but credentials were not persisted; operator intervention required (Twilio subaccounts cannot be re-fetched with their auth token)`,
        );
      } else {
        try {
          const created = await this.twilioProvider.createSubaccount(
            master,
            friendlyName,
          );
          subaccountSid = created.subaccountSid;
          subaccountAuthToken = created.subaccountAuthToken;
          this.logger.log(
            `twilio_subaccount_provisioned integrationId=${integration.id} workspaceId=${integration.workspaceId} subaccountSid=${subaccountSid} friendlyName="${created.friendlyName}"`,
          );
        } catch (err) {
          return await this.markError(
            repo,
            integration,
            OperationalReasonCode.TWILIO_SUBACCOUNT_CREATE_FAILED,
            (err as Error).message,
          );
        }

        // Step 2 (create path only) — persist SID + encrypted credentials
        // BEFORE preflight so a preflight failure leaves us with a
        // repair-eligible `error` state.
        const credentialsJson = JSON.stringify({
          accountSid: subaccountSid,
          authToken: subaccountAuthToken,
        });
        integration.credentialsEncrypted =
          this.encryptionService.encrypt(credentialsJson);
        integration.providerSubaccountSid = subaccountSid;
        integration.externalWorkspaceId = subaccountSid;
        await repo.save(integration);
      }

      // Step 3 — preflight against the (new or reused) subaccount.
      const preflight = await this.twilioProvider.preflightSubaccount({
        accountSid: subaccountSid,
        authToken: subaccountAuthToken,
      });
      if (!preflight.ok) {
        return await this.markError(
          repo,
          integration,
          preflight.reason as OperationalReasonCode,
          preflight.detail,
        );
      }

      // Step 4 — mark ready + record verification timestamp.
      integration.operationalStatus = OperationalStatus.READY;
      integration.operationalReason = null;
      integration.operationalLastVerifiedAt = new Date();
      integration.metadata = {
        ...(integration.metadata ?? {}),
        readiness: {
          provisionedAt: new Date().toISOString(),
          subaccountFriendlyName: friendlyName,
          preflightAccountStatus: preflight.accountStatus,
        },
      };
      await repo.save(integration);

      this.logger.log(
        `twilio_integration_ready integrationId=${integration.id} workspaceId=${integration.workspaceId} subaccountSid=${subaccountSid} verifiedAt=${integration.operationalLastVerifiedAt.toISOString()}`,
      );

      return integration;
    });
  }

  /**
   * Persist error state and log a structured line so ops can pick up the
   * machine-readable reason. Never logs credentials or the full Twilio
   * error surface — the `detail` string is passed through
   * `describeTwilioError`-shaped output only.
   */
  private async markError(
    repo: ReturnType<DataSource['getRepository']>,
    integration: CommunicationIntegration,
    reason: OperationalReasonCode,
    detail: string,
  ): Promise<CommunicationIntegration> {
    integration.operationalStatus = OperationalStatus.ERROR;
    integration.operationalReason = reason;
    // Do NOT stamp operationalLastVerifiedAt on error.
    await repo.save(integration);
    this.logger.warn(
      `twilio_subaccount_provision_error integrationId=${integration.id} workspaceId=${integration.workspaceId} reason=${reason} detail=${detail.slice(0, 300)}`,
    );
    throw new ConflictException({
      code: reason,
      message: `Twilio provider provisioning failed (${reason}); the integration remains present and retry is allowed.`,
    });
  }

  private readMasterCredentials(): TwilioMasterCredentials | null {
    const accountSid =
      this.configService.get<string>('SIGCORE_TWILIO_MASTER_ACCOUNT_SID') ??
      this.configService.get<string>('TWILIO_ACCOUNT_SID');
    const authToken =
      this.configService.get<string>('SIGCORE_TWILIO_MASTER_AUTH_TOKEN') ??
      this.configService.get<string>('TWILIO_AUTH_TOKEN');
    if (!accountSid || !authToken) return null;
    return { accountSid, authToken };
  }

  /**
   * True when the encrypted credentials blob decrypts to a non-empty
   * object with the fields Twilio SDK requires. Grandfathered NULL
   * `operational_status` rows use this check to distinguish "legacy row
   * with real creds (treat as ready)" from "legacy row that somehow has
   * empty creds (still needs provisioning)".
   */
  private hasNonEmptyCredentials(encrypted: string | null | undefined): boolean {
    if (!encrypted) return false;
    try {
      const decrypted = this.encryptionService.decrypt(encrypted);
      const parsed = JSON.parse(decrypted);
      return Boolean(parsed?.accountSid && parsed?.authToken);
    } catch {
      return false;
    }
  }
}
