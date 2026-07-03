/**
 * One-off backfill — attach missing Twilio recording URLs to historical
 * Call Connect sessions that ended before commit `be3ca20f` shipped.
 *
 * Prior to that fix, `TwilioWebhooksService.handleRecordingComplete` early-
 * returned when the CallSid wasn't in `communication_calls` (which is always
 * the case for CC agent/lead legs), so `attachRecordingToSession` never ran
 * and `CallConnectSession.recordingUrl` stayed null. The audio still exists
 * at Twilio; this script fetches each session's recording by agentCallSid
 * and replays the write + downstream emit via the same public method the
 * live path now uses (`callConnectService.attachRecordingToSession`).
 *
 * LB's webhook handler is idempotent on repeated `call_connect.ended`
 * events (see LB `call-connect.service.ts:1151` — it only writes fields
 * that are present in the payload and appends to the timeline), so
 * re-emitting for already-ENDED rows just populates `recordingUrl`.
 *
 * Scope:
 *   - Only sessions with status = ENDED (FAILED/CANCELED never had audio)
 *   - Only sessions with agentCallSid != null (no CallSid = nothing to look up)
 *   - Only sessions with recordingUrl IS NULL (avoid clobbering)
 *
 * Usage:
 *   DRY_RUN=1 npm run backfill:cc-recordings         # preview
 *   DRY_RUN=0 npm run backfill:cc-recordings         # execute
 *   DRY_RUN=0 SESSION_ID=<uuid> npm run backfill:cc-recordings   # one session
 *   DRY_RUN=0 SINCE=2026-07-01 npm run backfill:cc-recordings    # window
 */

import 'reflect-metadata';
import { config as loadDotEnv } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { DataSource, IsNull, Not } from 'typeorm';
import * as twilio from 'twilio';

import { AppModule } from '../app.module';
import {
  CallConnectSession,
  SessionStatus,
} from '../database/entities/call-connect-session.entity';
import {
  CommunicationIntegration,
  ProviderType,
} from '../database/entities/communication-integration.entity';
import { TenantIntegration } from '../database/entities/tenant-integration.entity';
import { EncryptionService } from '../common/services/encryption.service';
import { CallConnectService } from '../modules/webhooks/call-connect.service';

loadDotEnv();

const DRY_RUN = process.env.DRY_RUN !== '0';
const SESSION_ID = process.env.SESSION_ID?.trim() || null;
const SINCE = process.env.SINCE ? new Date(process.env.SINCE) : null;

function log(msg: string) {
  console.log(msg);
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const ds = app.get(DataSource);
    const sessionRepo = ds.getRepository(CallConnectSession);
    const integrationRepo = ds.getRepository(CommunicationIntegration);
    const tenantIntegrationRepo = ds.getRepository(TenantIntegration);
    const encryption = app.get(EncryptionService);
    const callConnect = app.get(CallConnectService);

    // ---------- 1. Find candidates ----------
    const where: Record<string, unknown> = {
      status: SessionStatus.ENDED,
      recordingUrl: IsNull(),
      agentCallSid: Not(IsNull()),
    };
    if (SESSION_ID) where.id = SESSION_ID;
    if (SINCE) where.createdAt = { $gt: SINCE } as never; // fallback below

    let candidates: CallConnectSession[];
    if (SINCE) {
      candidates = await sessionRepo
        .createQueryBuilder('s')
        .where('s.status = :st', { st: SessionStatus.ENDED })
        .andWhere('s.recording_url IS NULL')
        .andWhere('s.agent_call_sid IS NOT NULL')
        .andWhere('s.created_at >= :since', { since: SINCE.toISOString() })
        .orderBy('s.created_at', 'ASC')
        .getMany();
    } else {
      candidates = await sessionRepo.find({ where, order: { createdAt: 'ASC' } });
    }

    log(`Candidates: ${candidates.length} ENDED sessions with null recordingUrl and non-null agentCallSid`);
    if (SESSION_ID) log(`  (filter: SESSION_ID=${SESSION_ID})`);
    if (SINCE) log(`  (filter: SINCE=${SINCE.toISOString()})`);

    if (candidates.length === 0) {
      log('Nothing to backfill.');
      return;
    }

    // Twilio client cache keyed by "workspaceId::tenantId"
    const clientCache = new Map<string, twilio.Twilio | null>();
    async function twilioFor(workspaceId: string, tenantId: string | null): Promise<twilio.Twilio | null> {
      const k = `${workspaceId}::${tenantId ?? ''}`;
      if (clientCache.has(k)) return clientCache.get(k) ?? null;

      let creds: { accountSid: string; authToken: string } | null = null;
      if (tenantId) {
        const ti = await tenantIntegrationRepo.findOne({
          where: { workspaceId, tenantId, provider: ProviderType.TWILIO },
        });
        if (ti?.credentialsEncrypted) {
          creds = JSON.parse(encryption.decrypt(ti.credentialsEncrypted));
        }
      }
      if (!creds) {
        const wi = await integrationRepo.findOne({
          where: { workspaceId, provider: ProviderType.TWILIO },
        });
        if (wi?.credentialsEncrypted) {
          creds = JSON.parse(encryption.decrypt(wi.credentialsEncrypted));
        }
      }
      const client = creds ? twilio(creds.accountSid, creds.authToken) : null;
      clientCache.set(k, client);
      return client;
    }

    // ---------- 2. Process each ----------
    const summary = {
      total: candidates.length,
      attached: 0,
      no_recording_on_twilio: 0,
      no_twilio_integration: 0,
      twilio_error: 0,
      dry_run_preview: 0,
    };

    for (const s of candidates) {
      const client = await twilioFor(s.businessId, s.tenantId);
      if (!client) {
        log(`  SKIP  ${s.id.slice(0, 8)}  (no Twilio integration for ws=${s.businessId} tenant=${s.tenantId})`);
        summary.no_twilio_integration++;
        continue;
      }

      let recordings: Array<{ sid: string; accountSid: string; duration?: string | null }>;
      try {
        recordings = await client.recordings.list({ callSid: s.agentCallSid, limit: 1 });
      } catch (err: any) {
        log(`  ERR   ${s.id.slice(0, 8)}  Twilio list failed: ${err.message}`);
        summary.twilio_error++;
        continue;
      }

      if (!recordings || recordings.length === 0) {
        log(`  NONE  ${s.id.slice(0, 8)}  (no Twilio recording for CallSid ${s.agentCallSid})`);
        summary.no_recording_on_twilio++;
        continue;
      }

      const rec = recordings[0];
      const recordingUrl = `https://api.twilio.com/2010-04-01/Accounts/${rec.accountSid}/Recordings/${rec.sid}`;

      log(
        `  ${DRY_RUN ? 'DRY' : 'FIX'}   ${s.id.slice(0, 8)}  ${s.createdAt.toISOString()}  CallSid=${s.agentCallSid}  RecordingSid=${rec.sid}`,
      );

      if (DRY_RUN) {
        summary.dry_run_preview++;
        continue;
      }

      try {
        await callConnect.attachRecordingToSession(s.agentCallSid, recordingUrl);
        summary.attached++;
      } catch (err: any) {
        log(`    ! attachRecordingToSession failed: ${err.message}`);
        summary.twilio_error++;
      }
    }

    log('');
    log('Summary:');
    log(JSON.stringify(summary, null, 2));
    log(DRY_RUN ? '\n(DRY_RUN=1 — nothing written. Set DRY_RUN=0 to execute.)' : '\nDone.');
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
