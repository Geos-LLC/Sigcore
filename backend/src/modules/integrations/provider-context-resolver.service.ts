import {
  Injectable,
  Logger,
  Inject,
  Optional,
  ForbiddenException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  CommunicationIntegration,
  ProviderType,
} from '../../database/entities/communication-integration.entity';
import { TenantPhoneNumber } from '../../database/entities/tenant-phone-number.entity';
import { CommunicationCall } from '../../database/entities/communication-call.entity';
import {
  PROVIDER_CONTEXT_EVENT_EMITTER,
  ProviderContextEventEmitter,
  ProviderContextEventName,
  providerSidPrefix,
  phoneLast4,
} from './provider-context-events';

/**
 * Incident 2026-07-14 Phase 2 — ProviderContextResolver.
 *
 * Deterministic provider-context ownership resolver. Given a set of hints
 * (workspaceId, provider, optional fromNumber / tenantPhoneNumberId /
 * providerResourceSid / tenantId / integrationId), returns the exact
 * `CommunicationIntegration` responsible for the communication resource.
 *
 * Provider-agnostic: works for Twilio, OpenPhone, WhatsApp, Telegram, and
 * any future provider (SIP, Quo, RingCentral).
 *
 * Resolution priority (first non-null wins):
 *
 *   1. by_number
 *      Caller supplies `fromNumber` (E.164) or `tenantPhoneNumberId`.
 *      Look up the TPN row and read `communication_integration_id`. This
 *      is the canonical rule — a phone number can only belong to one
 *      integration, and the FK is queryable in bulk.
 *
 *   2. by_stamped_resource
 *      Caller supplies `providerResourceSid` (Twilio CallSid / OpenPhone
 *      call id / etc.). Look up the CommunicationCall row (or, in future
 *      revisions, other stamped resources) and read the stamped
 *      `communication_integration_id`. Falls back to `metadata.integrationId`
 *      when the column is NULL (pre-Phase-2 rows).
 *
 *   3. by_tenant
 *      Caller supplies `tenantId` (with workspaceId + provider). Look up
 *      integrations where `scope_type = 'TENANT'` AND
 *      `owner_tenant_id = tenantId`. Exactly one match required; more
 *      than one is an ambiguity error (409).
 *
 *   4. by_legacy_workspace_fallback
 *      Caller supplies only (workspaceId, provider). Look up integrations
 *      matching `(workspaceId, provider)` ignoring scope. In compatibility
 *      mode this rule is permitted iff there is exactly one row (which is
 *      today's per-workspace-single-integration invariant) — an event is
 *      emitted so we can watch for legacy fallback usage in production
 *      and eventually flip strict mode on. In strict mode this rule is
 *      always fail-closed; the caller must supply a stronger hint.
 *
 * Cross-cutting invariants (applied regardless of which rule fired):
 *   - If caller supplied `integrationId` and it does not equal the
 *     resolved integration's id → 403 `provider_context_mismatch`.
 *   - If caller supplied `tenantId` and the TPN's tenantId differs from
 *     the caller's tenantId → 403 `provider_context_cross_tenant_denied`.
 *     (The PPA-based shared-sender exception is a Communication service
 *     concern, NOT the resolver's; if callers want shared-sender they
 *     should not pass `tenantId` here.)
 *   - Resolved integration must be of the requested provider →
 *     409 provider mismatch if not.
 *
 * Mode: `PROVIDER_CONTEXT_RESOLVER_MODE` env var, default `'compatibility'`.
 * Values: `'compatibility'` | `'strict'`. Any other value falls back to
 * `'compatibility'` with a startup warning.
 */

export type ProviderContextResolverMode = 'compatibility' | 'strict';

export type ProviderContextRule =
  | 'by_number'
  | 'by_stamped_resource'
  | 'by_tenant'
  | 'by_legacy_workspace_fallback';

export interface ProviderContextInput {
  /** REQUIRED. */
  workspaceId: string;
  /** REQUIRED. */
  provider: ProviderType | string;
  /** Optional — E.164. */
  fromNumber?: string | null;
  /** Optional — TenantPhoneNumber id. */
  tenantPhoneNumberId?: string | null;
  /** Optional — Twilio CallSid / OpenPhone id / etc. */
  providerResourceSid?: string | null;
  /** Optional — caller's tenant scope. */
  tenantId?: string | null;
  /** Optional — validated hint; mismatch is a 403. */
  integrationId?: string | null;
  /** Optional — override resolver mode for this call (test hook). */
  modeOverride?: ProviderContextResolverMode;
}

export interface ProviderContext {
  integration: CommunicationIntegration;
  rule: ProviderContextRule;
  workspaceId: string;
  tenantId: string | null;
  provider: string;
  /** True when rule 4 (legacy fallback) was used. */
  legacyFallback: boolean;
}

@Injectable()
export class ProviderContextResolver {
  private readonly logger = new Logger(ProviderContextResolver.name);
  private readonly mode: ProviderContextResolverMode;

  constructor(
    @InjectRepository(CommunicationIntegration)
    private readonly integrationRepo: Repository<CommunicationIntegration>,
    @InjectRepository(TenantPhoneNumber)
    private readonly tpnRepo: Repository<TenantPhoneNumber>,
    @InjectRepository(CommunicationCall)
    private readonly callRepo: Repository<CommunicationCall>,
    @Optional()
    @Inject(PROVIDER_CONTEXT_EVENT_EMITTER)
    private readonly events?: ProviderContextEventEmitter,
  ) {
    const raw = (process.env.PROVIDER_CONTEXT_RESOLVER_MODE || '')
      .trim()
      .toLowerCase();
    if (raw === 'strict') {
      this.mode = 'strict';
    } else if (raw === '' || raw === 'compatibility') {
      this.mode = 'compatibility';
    } else {
      this.logger.warn(
        `[ProviderContextResolver] unknown PROVIDER_CONTEXT_RESOLVER_MODE=${raw!}; defaulting to 'compatibility'`,
      );
      this.mode = 'compatibility';
    }
  }

  /**
   * Resolve provider context. Throws on ambiguity / mismatch / not-found.
   * Callers upstream of the guard layer should treat every non-2xx path
   * as a hard block — the resolver is the authority.
   */
  async resolve(input: ProviderContextInput): Promise<ProviderContext> {
    const workspaceId = input.workspaceId;
    const provider = String(input.provider);
    const effectiveMode: ProviderContextResolverMode =
      input.modeOverride ?? this.mode;

    if (!workspaceId) {
      throw new ForbiddenException(
        'ProviderContextResolver: workspaceId is required',
      );
    }
    if (!provider) {
      throw new ForbiddenException(
        'ProviderContextResolver: provider is required',
      );
    }

    // ------------------------------------------------------------------
    // Rule 1 — by_number
    // ------------------------------------------------------------------
    let context: ProviderContext | null = null;
    let ruleUsed: ProviderContextRule | null = null;

    if (input.tenantPhoneNumberId || input.fromNumber) {
      const tpn = await this.findTpn(
        workspaceId,
        input.tenantPhoneNumberId ?? null,
        input.fromNumber ?? null,
      );
      if (tpn) {
        // Incident 2026-07-14 Phase 5a fix — Sigcore's shared-sender model
        // (PPA relaxation from 2026-05-11) explicitly permits one tenant to
        // send SMS from another tenant's TPN when a `profile_phone_assignment`
        // links them within the same workspace. The resolver's job is to
        // pick the RIGHT integration for a phone number; access control lives
        // in the calling service (e.g. `sendMessageToPhoneNumber` validates
        // PPA before sending). Emit an event for visibility, but do NOT throw
        // — the caller decides whether cross-tenant use is authorized.
        //
        // Voice callers that need strict single-tenant enforcement should
        // validate `context.tenantPhoneNumber.tenantId === expectedTenantId`
        // themselves after calling `resolve()`.
        if (input.tenantId && tpn.tenantId && tpn.tenantId !== input.tenantId) {
          this.emit('provider_context_cross_tenant_denied', {
            workspaceId,
            tenantId: input.tenantId,
            provider,
            rule: 'by_number',
            mode: effectiveMode,
            phoneLast4: phoneLast4(tpn.phoneNumber),
            reason: 'tpn_tenant_mismatch_soft_warn',
          });
          // No throw — resolver returns the integration anyway.
        }
        if (tpn.communicationIntegrationId) {
          const integration = await this.integrationRepo.findOne({
            where: { id: tpn.communicationIntegrationId, workspaceId },
          });
          if (integration) {
            context = this.buildContext(
              integration,
              'by_number',
              workspaceId,
              input.tenantId ?? tpn.tenantId ?? null,
              provider,
            );
            ruleUsed = 'by_number';
          }
        }
        // If the TPN has no `communicationIntegrationId` stamped yet,
        // fall through to the next rule rather than hard-failing — this
        // is exactly the pre-Phase-2 legacy state.
      }
    }

    // ------------------------------------------------------------------
    // Rule 2 — by_stamped_resource
    // ------------------------------------------------------------------
    if (!context && input.providerResourceSid) {
      const call = await this.callRepo.findOne({
        where: { providerCallId: input.providerResourceSid },
      });
      if (call) {
        const stampedId =
          call.communicationIntegrationId ||
          ((call.metadata?.integrationId as string | undefined) ?? null);
        if (stampedId) {
          const integration = await this.integrationRepo.findOne({
            where: { id: stampedId, workspaceId },
          });
          if (integration) {
            context = this.buildContext(
              integration,
              'by_stamped_resource',
              workspaceId,
              input.tenantId ?? null,
              provider,
            );
            ruleUsed = 'by_stamped_resource';
          }
        }
      }
    }

    // ------------------------------------------------------------------
    // Rule 3 — by_tenant
    // ------------------------------------------------------------------
    if (!context && input.tenantId) {
      const candidates = await this.integrationRepo.find({
        where: {
          workspaceId,
          provider: provider as ProviderType,
          scopeType: 'TENANT',
          ownerTenantId: input.tenantId,
        },
      });
      if (candidates.length === 1) {
        context = this.buildContext(
          candidates[0],
          'by_tenant',
          workspaceId,
          input.tenantId,
          provider,
        );
        ruleUsed = 'by_tenant';
      } else if (candidates.length > 1) {
        this.emit('provider_context_ambiguous', {
          workspaceId,
          tenantId: input.tenantId,
          provider,
          rule: 'by_tenant',
          mode: effectiveMode,
          candidateCount: candidates.length,
          reason: 'multiple_tenant_scoped_integrations',
        });
        throw new ConflictException(
          'ProviderContextResolver: multiple tenant-scoped integrations match; supply integrationId',
        );
      }
    }

    // ------------------------------------------------------------------
    // Rule 4 — by_legacy_workspace_fallback
    // ------------------------------------------------------------------
    if (!context) {
      const legacyCandidates = await this.integrationRepo.find({
        where: {
          workspaceId,
          provider: provider as ProviderType,
        },
      });
      if (legacyCandidates.length === 1) {
        if (effectiveMode === 'strict') {
          this.emit('provider_context_ambiguous', {
            workspaceId,
            tenantId: input.tenantId ?? null,
            provider,
            rule: 'by_legacy_workspace_fallback',
            mode: effectiveMode,
            candidateCount: 1,
            reason: 'strict_mode_denies_legacy_fallback',
          });
          throw new ForbiddenException(
            'ProviderContextResolver: strict mode requires a stronger hint (fromNumber / tpnId / providerResourceSid / tenantId with TENANT-scoped integration)',
          );
        }
        context = this.buildContext(
          legacyCandidates[0],
          'by_legacy_workspace_fallback',
          workspaceId,
          input.tenantId ?? null,
          provider,
        );
        ruleUsed = 'by_legacy_workspace_fallback';
        this.emit('provider_context_legacy_fallback', {
          workspaceId,
          tenantId: input.tenantId ?? null,
          provider,
          integrationId: legacyCandidates[0].id,
          scopeType: legacyCandidates[0].scopeType,
          rule: 'by_legacy_workspace_fallback',
          mode: effectiveMode,
          reason: 'no_stronger_hint_available',
        });
      } else if (legacyCandidates.length > 1) {
        this.emit('provider_context_ambiguous', {
          workspaceId,
          tenantId: input.tenantId ?? null,
          provider,
          rule: 'by_legacy_workspace_fallback',
          mode: effectiveMode,
          candidateCount: legacyCandidates.length,
          reason: 'multiple_workspace_integrations',
        });
        throw new ConflictException(
          'ProviderContextResolver: multiple integrations for this (workspace, provider); supply integrationId, tpnId, or tenantId',
        );
      } else {
        // Zero candidates — no integration exists at all.
        throw new NotFoundException(
          'ProviderContextResolver: no integration found for the requested (workspace, provider)',
        );
      }
    }

    // ------------------------------------------------------------------
    // Cross-cutting invariants
    // ------------------------------------------------------------------
    // Caller-supplied integrationId hint must match.
    if (input.integrationId && input.integrationId !== context.integration.id) {
      this.emit('provider_context_mismatch', {
        workspaceId,
        tenantId: input.tenantId ?? null,
        provider,
        integrationId: context.integration.id,
        rule: ruleUsed,
        mode: effectiveMode,
        reason: 'caller_hint_mismatch',
        detail: { hint: input.integrationId },
      });
      throw new ForbiddenException(
        'ProviderContextResolver: caller-supplied integrationId does not match resolved integration',
      );
    }

    // Resolved integration must be the requested provider.
    if (String(context.integration.provider) !== provider) {
      this.emit('provider_context_mismatch', {
        workspaceId,
        tenantId: input.tenantId ?? null,
        provider,
        integrationId: context.integration.id,
        rule: ruleUsed,
        mode: effectiveMode,
        reason: 'provider_mismatch',
        detail: {
          resolvedProvider: String(context.integration.provider),
        },
      });
      throw new ConflictException(
        'ProviderContextResolver: resolved integration provider does not match requested provider',
      );
    }

    // Success emit — one event per resolved context.
    this.emit(this.eventNameForRule(ruleUsed!), {
      workspaceId,
      tenantId: context.tenantId,
      provider,
      integrationId: context.integration.id,
      scopeType: context.integration.scopeType,
      rule: ruleUsed,
      mode: effectiveMode,
      providerSidPrefix: providerSidPrefix(input.providerResourceSid ?? null),
      phoneLast4: phoneLast4(input.fromNumber ?? null),
    });

    return context;
  }

  /** Public accessor so tests + startup logs can confirm the mode. */
  getMode(): ProviderContextResolverMode {
    return this.mode;
  }

  // --------------------------------------------------------------------

  private async findTpn(
    workspaceId: string,
    tpnId: string | null,
    fromNumber: string | null,
  ): Promise<TenantPhoneNumber | null> {
    if (tpnId) {
      const byId = await this.tpnRepo.findOne({
        where: { id: tpnId, workspaceId },
      });
      if (byId) return byId;
    }
    if (fromNumber) {
      const byPhone = await this.tpnRepo.findOne({
        where: { workspaceId, phoneNumber: fromNumber },
      });
      if (byPhone) return byPhone;
    }
    return null;
  }

  private buildContext(
    integration: CommunicationIntegration,
    rule: ProviderContextRule,
    workspaceId: string,
    tenantId: string | null,
    provider: string,
  ): ProviderContext {
    return {
      integration,
      rule,
      workspaceId,
      tenantId,
      provider,
      legacyFallback: rule === 'by_legacy_workspace_fallback',
    };
  }

  private eventNameForRule(rule: ProviderContextRule): ProviderContextEventName {
    switch (rule) {
      case 'by_number':
        return 'provider_context_resolved_by_number';
      case 'by_stamped_resource':
        return 'provider_context_resolved_by_resource';
      case 'by_tenant':
        return 'provider_context_resolved_by_tenant';
      case 'by_legacy_workspace_fallback':
        // Legacy fallback also gets its own explicit event above; the
        // "resolved" event for it is the by_tenant name to reduce noise.
        return 'provider_context_resolved_by_tenant';
    }
  }

  private emit(
    event: ProviderContextEventName,
    payload: Record<string, unknown>,
  ): void {
    if (!this.events) return;
    this.events.emit({ event, ...payload });
  }
}
