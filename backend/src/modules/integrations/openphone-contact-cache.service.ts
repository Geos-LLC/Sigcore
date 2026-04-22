import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ProviderType, CommunicationIntegration } from '../../database/entities/communication-integration.entity';
import { TenantIntegration } from '../../database/entities/tenant-integration.entity';
import { OpenPhoneContactSnapshot } from '../../database/entities/openphone-contact-snapshot.entity';
import { CommunicationParticipant } from '../../database/entities/communication-participant.entity';
import { CommunicationConversation } from '../../database/entities/communication-conversation.entity';
import { OpenPhoneProvider } from '../communication/providers/openphone.provider';
import { EncryptionService } from '../../common/services/encryption.service';
import { normalizeToE164 } from '../../common/util/phone';

export interface SnapshotUpsertInput {
  workspaceId: string;
  tenantId: string;
  providerAccountId?: string | null;
  phoneE164: string;
  phoneLast10: string;
  providerContactId?: string | null;
  providerFirstName?: string | null;
  providerLastName?: string | null;
  providerCompany?: string | null;
  providerUpdatedAt?: Date | null;
  metadata?: Record<string, unknown> | null;
}

export interface ParticipantUpsertInput {
  workspaceId: string;
  tenantId: string;
  providerAccountId?: string | null;
  phoneE164: string;
  rawPhone?: string | null;
}

/**
 * Resolve an OpenPhone contact display name from its three name-ish fields.
 * See plans/SIGCORE_OPENPHONE_CORRELATION.md §7.2.
 */
export function resolveDisplayName(
  s: { providerFirstName?: string | null; providerLastName?: string | null; providerCompany?: string | null },
): string | null {
  const first = (s.providerFirstName || '').trim();
  const last = (s.providerLastName || '').trim();
  const full = [first, last].filter(Boolean).join(' ').trim();
  if (full) return full;
  const company = (s.providerCompany || '').trim();
  if (company) return company;
  return null;
}

@Injectable()
export class OpenPhoneContactCacheService {
  private readonly logger = new Logger(OpenPhoneContactCacheService.name);

  constructor(
    @InjectRepository(OpenPhoneContactSnapshot)
    private snapshotRepo: Repository<OpenPhoneContactSnapshot>,
    @InjectRepository(CommunicationParticipant)
    private participantRepo: Repository<CommunicationParticipant>,
    @InjectRepository(CommunicationConversation)
    private conversationRepo: Repository<CommunicationConversation>,
    @InjectRepository(CommunicationIntegration)
    private integrationRepo: Repository<CommunicationIntegration>,
    @InjectRepository(TenantIntegration)
    private tenantIntegrationRepo: Repository<TenantIntegration>,
    private openPhoneProvider: OpenPhoneProvider,
    private encryptionService: EncryptionService,
    private dataSource: DataSource,
  ) {}

  /**
   * Source A + B — shared upsert for snapshot + cascade to dependent participants.
   * See plan §6.4. Runs in one transaction so partial failures leave both rows consistent.
   */
  async upsertSnapshotAndCascade(input: SnapshotUpsertInput): Promise<void> {
    const displayName = resolveDisplayName({
      providerFirstName: input.providerFirstName,
      providerLastName: input.providerLastName,
      providerCompany: input.providerCompany,
    });

    const accountId = input.providerAccountId ?? '';
    await this.dataSource.transaction(async (tx) => {
      await tx.query(
        `
        INSERT INTO "openphone_contact_snapshot"
          ("workspace_id", "tenant_id", "provider_account_id",
           "phone_e164", "phone_last10",
           "provider_contact_id",
           "provider_first_name", "provider_last_name", "provider_company",
           "provider_updated_at", "metadata", "created_at", "updated_at")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), now())
        ON CONFLICT ("workspace_id", "provider_account_id", "phone_e164")
        DO UPDATE SET
          "tenant_id"           = COALESCE(EXCLUDED."tenant_id", "openphone_contact_snapshot"."tenant_id"),
          "provider_contact_id" = EXCLUDED."provider_contact_id",
          "provider_first_name" = EXCLUDED."provider_first_name",
          "provider_last_name"  = EXCLUDED."provider_last_name",
          "provider_company"    = EXCLUDED."provider_company",
          "provider_updated_at" = EXCLUDED."provider_updated_at",
          "metadata"            = EXCLUDED."metadata",
          "updated_at"          = now()
        WHERE "openphone_contact_snapshot"."provider_updated_at" IS NULL
           OR EXCLUDED."provider_updated_at" IS NULL
           OR EXCLUDED."provider_updated_at" >= "openphone_contact_snapshot"."provider_updated_at"
        `,
        [
          input.workspaceId,
          input.tenantId ?? null,
          accountId,
          input.phoneE164,
          input.phoneLast10,
          input.providerContactId ?? null,
          input.providerFirstName ?? null,
          input.providerLastName ?? null,
          input.providerCompany ?? null,
          input.providerUpdatedAt ?? null,
          input.metadata ? JSON.stringify(input.metadata) : null,
        ],
      );

      // Cascade to ALL tenants' participants sharing this phone in this workspace.
      // Snapshots are workspace-scoped; participants are tenant-scoped; all tenants
      // that see this phone should reflect the latest snapshot.
      await tx.query(
        `
        UPDATE "communication_participants"
        SET "provider_contact_id"   = $3,
            "provider_display_name" = $4,
            "provider_company"      = $5,
            "updated_at"            = now()
        WHERE "workspace_id" = $1
          AND "provider" = 'openphone'
          AND "normalized_phone_e164" = $2
          AND (
            "provider_contact_id"   IS DISTINCT FROM $3
            OR "provider_display_name" IS DISTINCT FROM $4
            OR "provider_company"   IS DISTINCT FROM $5
          )
        `,
        [
          input.workspaceId,
          input.phoneE164,
          input.providerContactId ?? null,
          displayName,
          input.providerCompany ?? null,
        ],
      );
    });
  }

  /**
   * Source B — contact.deleted webhook. Nulls provider fields on snapshot + participants
   * but keeps the rows (conversations may still reference them).
   */
  async deleteSnapshotAndCascade(workspaceId: string, phoneE164: string): Promise<void> {
    await this.dataSource.transaction(async (tx) => {
      await tx.query(
        `
        UPDATE "openphone_contact_snapshot"
        SET "provider_contact_id" = NULL,
            "provider_first_name" = NULL,
            "provider_last_name"  = NULL,
            "provider_company"    = NULL,
            "updated_at"          = now()
        WHERE "workspace_id" = $1 AND "phone_e164" = $2
        `,
        [workspaceId, phoneE164],
      );
      await tx.query(
        `
        UPDATE "communication_participants"
        SET "provider_contact_id"   = NULL,
            "provider_display_name" = NULL,
            "provider_company"      = NULL,
            "updated_at"            = now()
        WHERE "workspace_id" = $1
          AND "provider" = 'openphone'
          AND "normalized_phone_e164" = $2
        `,
        [workspaceId, phoneE164],
      );
    });
  }

  /**
   * Source C — called during conversation ingest. Ensures a participant exists
   * for the phone and returns it. Fills provider fields from any existing snapshot.
   */
  async upsertParticipantFromConversation(input: ParticipantUpsertInput): Promise<CommunicationParticipant> {
    const accountId = input.providerAccountId ?? '';
    const participantKey = `openphone:${input.tenantId}:${accountId}:${input.phoneE164}`;

    const snapshot = await this.snapshotRepo.findOne({
      where: { workspaceId: input.workspaceId, phoneE164: input.phoneE164 },
    });

    const providerFields = snapshot
      ? {
          providerContactId: snapshot.providerContactId ?? null,
          providerDisplayName: resolveDisplayName(snapshot),
          providerCompany: snapshot.providerCompany ?? null,
        }
      : { providerContactId: null, providerDisplayName: null, providerCompany: null };

    await this.dataSource.query(
      `
      INSERT INTO "communication_participants"
        ("workspace_id", "tenant_id", "provider", "provider_account_id",
         "participant_key", "normalized_phone_e164", "raw_phone",
         "provider_contact_id", "provider_display_name", "provider_company",
         "first_seen_at", "last_seen_at", "created_at", "updated_at")
      VALUES ($1, $2, 'openphone', $3, $4, $5, $6, $7, $8, $9, now(), now(), now(), now())
      ON CONFLICT ("workspace_id", "tenant_id", "provider", "provider_account_id", "normalized_phone_e164")
      DO UPDATE SET
        "last_seen_at" = now(),
        "raw_phone"    = COALESCE("communication_participants"."raw_phone", EXCLUDED."raw_phone"),
        "provider_contact_id" = COALESCE(EXCLUDED."provider_contact_id", "communication_participants"."provider_contact_id"),
        "provider_display_name" = COALESCE(EXCLUDED."provider_display_name", "communication_participants"."provider_display_name"),
        "provider_company" = COALESCE(EXCLUDED."provider_company", "communication_participants"."provider_company"),
        "updated_at" = now()
      `,
      [
        input.workspaceId,
        input.tenantId,
        accountId,
        participantKey,
        input.phoneE164,
        input.rawPhone ?? null,
        providerFields.providerContactId,
        providerFields.providerDisplayName,
        providerFields.providerCompany,
      ],
    );

    const participant = await this.participantRepo.findOne({
      where: {
        workspaceId: input.workspaceId,
        tenantId: input.tenantId,
        provider: 'openphone',
        providerAccountId: accountId,
        normalizedPhoneE164: input.phoneE164,
      },
    });
    if (!participant) throw new Error(`Participant upsert failed for ${input.phoneE164}`);
    return participant;
  }

  /**
   * Source A — paginate OpenPhone /contacts and write snapshots (cascading to participants).
   * Safe to run repeatedly; idempotent per §10.
   */
  async syncContactsFromOpenPhone(workspaceId: string, tenantId: string): Promise<{
    contactsScanned: number;
    snapshotsWritten: number;
    participantsCascaded: number;
    phoneNormalizationFailures: number;
  }> {
    const credentials = await this.resolveCredentials(workspaceId, tenantId);
    const phoneNumberMap = await this.openPhoneProvider.getPhoneNumbersFromCredentials(credentials);
    const providerAccountId = phoneNumberMap.size > 0 ? (phoneNumberMap.values().next().value?.id ?? '') : '';

    const contacts = await this.openPhoneProvider.getOpenPhoneContacts(credentials);
    this.logger.log(`syncContactsFromOpenPhone: fetched ${contacts.length} contacts for tenant ${tenantId}`);

    let snapshotsWritten = 0;
    let phoneNormalizationFailures = 0;

    for (const contact of contacts) {
      for (const pn of contact.phoneNumbers || []) {
        if (!pn.value) continue;
        const { e164, last10 } = normalizeToE164(pn.value);
        if (!e164 || !last10) {
          phoneNormalizationFailures++;
          this.logger.warn(`openphone cache: unparseable phone ${pn.value} on contact ${contact.id}`);
          continue;
        }
        await this.upsertSnapshotAndCascade({
          workspaceId,
          tenantId,
          providerAccountId,
          phoneE164: e164,
          phoneLast10: last10,
          providerContactId: contact.id,
          providerFirstName: contact.firstName ?? null,
          providerLastName: contact.lastName ?? null,
          providerCompany: contact.company ?? null,
          providerUpdatedAt: contact.updatedAt ? new Date(contact.updatedAt) : null,
          metadata: {
            source: 'openphone_sync',
            customFieldCount: contact.customFields?.length ?? 0,
          },
        });
        snapshotsWritten++;
      }
    }

    // Count how many participants were cascaded (rough; join against snapshot)
    const { count } = await this.participantRepo
      .createQueryBuilder('p')
      .select('COUNT(DISTINCT p.id)', 'count')
      .where('p.workspaceId = :ws AND p.tenantId = :t AND p.provider = :provider', {
        ws: workspaceId, t: tenantId, provider: 'openphone',
      })
      .andWhere('p.providerContactId IS NOT NULL')
      .getRawOne();

    return {
      contactsScanned: contacts.length,
      snapshotsWritten,
      participantsCascaded: Number(count || 0),
      phoneNormalizationFailures,
    };
  }

  /**
   * Multi-step backfill per plan §10. Creates participants for existing conversations,
   * repairs participants missing provider linkage, repairs stale fields.
   */
  async backfill(workspaceId: string, tenantId: string, options: { dryRun?: boolean } = {}): Promise<{
    step1: Awaited<ReturnType<OpenPhoneContactCacheService['syncContactsFromOpenPhone']>>;
    step2_conversationsLinked: number;
    step2_normalizationFailures: number;
    step3_participantsRepaired: number;
    step4_staleParticipantsFixed: number;
  }> {
    const dryRun = !!options.dryRun;
    this.logger.log(`backfill start: tenant=${tenantId}, dryRun=${dryRun}`);

    // Step 1 — sync all snapshots (cascade to any existing participants)
    const step1 = dryRun
      ? { contactsScanned: 0, snapshotsWritten: 0, participantsCascaded: 0, phoneNormalizationFailures: 0 }
      : await this.syncContactsFromOpenPhone(workspaceId, tenantId);

    // Provider account id for participant creation
    const providerAccountId = await this.sniffProviderAccountId(workspaceId, tenantId);

    // Step 2 — conversations with no participant_id → create + link
    // For OpenPhone we scope by (workspace + provider) and also accept tenant_id IS NULL rows
    // (legacy pre-tenant-isolation conversations) since they belong to this workspace's single
    // OpenPhone tenant by construction.
    let conversationsLinked = 0;
    let normalizationFailures = 0;
    const chunkSize = 500;
    let iterations = 0;
    const maxIterations = 200; // safety
    while (iterations++ < maxIterations) {
      const convs = await this.conversationRepo
        .createQueryBuilder('c')
        .where('c.workspaceId = :ws', { ws: workspaceId })
        .andWhere('c.provider = :provider', { provider: 'openphone' })
        .andWhere('(c.tenantId = :t OR c.tenantId IS NULL)', { t: tenantId })
        .andWhere('c.participantId IS NULL')
        .andWhere('c.participantPhoneNumber IS NOT NULL')
        .orderBy('c.createdAt', 'ASC')
        .limit(chunkSize)
        .getMany();
      if (convs.length === 0) break;
      let anyProgress = false;
      for (const conv of convs) {
        const { e164, last10 } = normalizeToE164(conv.participantPhoneNumber);
        if (!e164 || !last10) {
          normalizationFailures++;
          // Mark as "attempted" by setting a placeholder to prevent infinite loop on same rows
          if (!dryRun) {
            await this.conversationRepo.update(conv.id, { participantPhoneE164: '' });
          }
          anyProgress = true;
          continue;
        }
        if (dryRun) {
          conversationsLinked++;
          anyProgress = true;
          continue;
        }
        const participant = await this.upsertParticipantFromConversation({
          workspaceId, tenantId, providerAccountId, phoneE164: e164, rawPhone: conv.participantPhoneNumber,
        });
        await this.conversationRepo.update(conv.id, {
          participantId: participant.id,
          participantKey: participant.participantKey,
          participantPhoneE164: e164,
        });
        conversationsLinked++;
        anyProgress = true;
      }
      if (dryRun) break; // don't loop forever in dryRun since we don't write
      if (!anyProgress) break;
    }

    // Step 3 — participants missing provider linkage but a snapshot exists
    let participantsRepaired = 0;
    if (!dryRun) {
      const stale = await this.dataSource.query(
        `
        SELECT p.id, p.normalized_phone_e164, s.provider_contact_id, s.provider_first_name, s.provider_last_name, s.provider_company
        FROM communication_participants p
        JOIN openphone_contact_snapshot s
          ON s.workspace_id = p.workspace_id
         AND s.phone_e164 = p.normalized_phone_e164
        WHERE p.workspace_id = $1
          AND p.tenant_id = $2
          AND p.provider = 'openphone'
          AND p.provider_contact_id IS NULL
          AND s.provider_contact_id IS NOT NULL
        `,
        [workspaceId, tenantId],
      );
      for (const row of stale as Array<{ id: string; normalized_phone_e164: string; provider_contact_id: string; provider_first_name?: string; provider_last_name?: string; provider_company?: string }>) {
        await this.participantRepo.update(row.id, {
          providerContactId: row.provider_contact_id,
          providerDisplayName: resolveDisplayName({
            providerFirstName: row.provider_first_name,
            providerLastName: row.provider_last_name,
            providerCompany: row.provider_company,
          }) ?? undefined,
          providerCompany: row.provider_company,
        });
        participantsRepaired++;
      }
    }

    // Step 4 — participants with stale provider fields vs snapshot
    let staleFixed = 0;
    if (!dryRun) {
      const mismatched = await this.dataSource.query(
        `
        SELECT p.id, p.provider_contact_id AS p_contact, p.provider_display_name AS p_display, p.provider_company AS p_company,
               s.provider_contact_id AS s_contact, s.provider_first_name, s.provider_last_name, s.provider_company AS s_company
        FROM communication_participants p
        JOIN openphone_contact_snapshot s
          ON s.workspace_id = p.workspace_id
         AND s.phone_e164 = p.normalized_phone_e164
        WHERE p.workspace_id = $1
          AND p.tenant_id = $2
          AND p.provider = 'openphone'
        `,
        [workspaceId, tenantId],
      );
      for (const row of mismatched as Array<Record<string, string | null>>) {
        const newDisplay = resolveDisplayName({
          providerFirstName: row.provider_first_name,
          providerLastName: row.provider_last_name,
          providerCompany: row.s_company,
        });
        if (row.p_contact !== row.s_contact || row.p_display !== newDisplay || row.p_company !== row.s_company) {
          await this.participantRepo.update(row.id!, {
            providerContactId: row.s_contact ?? undefined,
            providerDisplayName: newDisplay ?? undefined,
            providerCompany: row.s_company ?? undefined,
          });
          staleFixed++;
        }
      }
    }

    const result = {
      step1,
      step2_conversationsLinked: conversationsLinked,
      step2_normalizationFailures: normalizationFailures,
      step3_participantsRepaired: participantsRepaired,
      step4_staleParticipantsFixed: staleFixed,
    };
    this.logger.log(`backfill done: tenant=${tenantId} ${JSON.stringify(result)}`);
    return result;
  }

  async sniffProviderAccountId(workspaceId: string, tenantId: string): Promise<string> {
    try {
      const credentials = await this.resolveCredentials(workspaceId, tenantId);
      const map = await this.openPhoneProvider.getPhoneNumbersFromCredentials(credentials);
      const first = map.values().next().value;
      return first?.id ?? '';
    } catch {
      return '';
    }
  }

  private async resolveCredentials(workspaceId: string, tenantId: string): Promise<string> {
    let integration: CommunicationIntegration | TenantIntegration | null = null;
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
    if (!integration) throw new NotFoundException('OpenPhone integration not found');
    return this.encryptionService.decrypt(integration.credentialsEncrypted);
  }
}
