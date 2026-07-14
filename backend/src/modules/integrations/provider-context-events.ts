import { Injectable, Logger } from '@nestjs/common';

/**
 * Incident 2026-07-14 Phase 2 — structured events emitted by
 * `ProviderContextResolver` and adjacent guard code. Events are shipped
 * to LogHub via the existing `@geos/loghub-client` (backend logger) and
 * end up in Grafana Loki under `service_name="sigcore-api"`.
 *
 * NEVER emit:
 *   - credentials / encrypted blobs
 *   - auth tokens (X-Sigcore-Key, X-Api-Key, JWTs)
 *   - encryption keys
 *   - full phone numbers (mask to last-4)
 *   - full provider SIDs (first 4 chars only)
 *
 * Consumers may replace the default `LoggingProviderContextEventEmitter`
 * via the `PROVIDER_CONTEXT_EVENT_EMITTER` DI token if they need to fan
 * out to metrics / alerting pipelines.
 */

export type ProviderContextEventName =
  | 'provider_context_resolved_by_number'
  | 'provider_context_resolved_by_resource'
  | 'provider_context_resolved_by_tenant'
  | 'provider_context_legacy_fallback'
  | 'provider_context_ambiguous'
  | 'provider_context_mismatch'
  | 'provider_context_cross_tenant_denied'
  | 'phone_number_integration_backfilled';

export interface ProviderContextEvent {
  event: ProviderContextEventName;
  /** ISO timestamp; the emitter sets this if missing. */
  ts?: string;
  workspaceId?: string | null;
  tenantId?: string | null;
  provider?: string | null;
  integrationId?: string | null;
  scopeType?: string | null;
  /** Resolution rule that fired: 'by_number' | 'by_stamped_resource' | 'by_tenant' | 'by_legacy_workspace_fallback' */
  rule?: string | null;
  /** Resolver mode at the time of the event: 'compatibility' | 'strict' */
  mode?: string | null;
  /** Count of candidate rows found (for ambiguity events). */
  candidateCount?: number | null;
  /** Reason string for denials / fallbacks (short slug, not free-form text). */
  reason?: string | null;
  /** Optional first-4 chars of provider SID (never full SID). */
  providerSidPrefix?: string | null;
  /** Optional last-4 chars of phone number (never full phone). */
  phoneLast4?: string | null;
  /** Free-form structured detail; caller is responsible for redaction. */
  detail?: Record<string, unknown>;
}

export const PROVIDER_CONTEXT_EVENT_EMITTER = 'PROVIDER_CONTEXT_EVENT_EMITTER';

export interface ProviderContextEventEmitter {
  emit(event: ProviderContextEvent): void;
}

/**
 * Default emitter — logs a single-line JSON blob per event to Nest's
 * Logger. LogHub picks stdout up and forwards to Loki. Fire-and-forget:
 * a downstream logger crash must never affect resolver behavior, so the
 * emit path is wrapped in a defensive try/catch.
 */
@Injectable()
export class LoggingProviderContextEventEmitter
  implements ProviderContextEventEmitter
{
  private readonly logger = new Logger('ProviderContextEvent');

  emit(event: ProviderContextEvent): void {
    try {
      const payload: ProviderContextEvent = {
        ts: event.ts ?? new Date().toISOString(),
        ...event,
      };
      // Single-line JSON so LogHub / Loki parses cleanly.
      this.logger.log(JSON.stringify(payload));
    } catch {
      // Never let a logging failure escape the resolver.
    }
  }
}

/**
 * Helper — return first 4 chars of a provider SID (e.g. Twilio "CAxxxxx"
 * -> "CAxx") or NULL for empty/undefined input. Never use full SIDs in
 * emitted events.
 */
export function providerSidPrefix(
  sid: string | null | undefined,
): string | null {
  if (!sid) return null;
  return sid.slice(0, 4);
}

/**
 * Helper — return last 4 chars of an E.164 phone number, prefixed with
 * `****`. Never emit the full phone.
 */
export function phoneLast4(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return null;
  return `****${digits.slice(-4)}`;
}
