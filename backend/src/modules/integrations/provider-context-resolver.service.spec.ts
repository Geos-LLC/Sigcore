/**
 * Incident 2026-07-14 Phase 2 — ProviderContextResolver.
 *
 * Covers the 4-rule priority chain + cross-cutting invariants + compat vs
 * strict mode behavior. Tests use hand-rolled repo mocks (matching the
 * pattern used elsewhere in this module) rather than a full
 * @nestjs/testing harness — the resolver has no side-effects worth
 * exercising through the DI container.
 */

import {
  ForbiddenException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ProviderContextResolver } from './provider-context-resolver.service';
import {
  ProviderContextEventEmitter,
  ProviderContextEvent,
} from './provider-context-events';
import { ProviderType } from '../../database/entities/communication-integration.entity';

function buildMockRepo() {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
  };
}

function buildEmitter() {
  const emitted: ProviderContextEvent[] = [];
  const emitter: ProviderContextEventEmitter = {
    emit: (e: ProviderContextEvent) => {
      emitted.push(e);
    },
  };
  return { emitter, emitted };
}

function build(mode?: 'compatibility' | 'strict') {
  const prev = process.env.PROVIDER_CONTEXT_RESOLVER_MODE;
  if (mode) {
    process.env.PROVIDER_CONTEXT_RESOLVER_MODE = mode;
  } else {
    delete process.env.PROVIDER_CONTEXT_RESOLVER_MODE;
  }
  const integrationRepo = buildMockRepo();
  const tpnRepo = buildMockRepo();
  const callRepo = buildMockRepo();
  const { emitter, emitted } = buildEmitter();
  const svc = new ProviderContextResolver(
    integrationRepo as any,
    tpnRepo as any,
    callRepo as any,
    emitter,
  );
  // Restore env immediately — constructor already read it.
  if (prev === undefined) {
    delete process.env.PROVIDER_CONTEXT_RESOLVER_MODE;
  } else {
    process.env.PROVIDER_CONTEXT_RESOLVER_MODE = prev;
  }
  return { svc, integrationRepo, tpnRepo, callRepo, emitted };
}

const WS = 'ws-1';
const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';
const INT_ID = 'integration-1';
const OTHER_INT_ID = 'integration-2';
const TPN_ID = 'tpn-1';
const PHONE = '+19045778584';
const CALL_SID = 'CA1234567890abcdef';

const twilioIntegration = (overrides: Record<string, any> = {}) => ({
  id: INT_ID,
  workspaceId: WS,
  provider: ProviderType.TWILIO,
  scopeType: 'WORKSPACE',
  ownerTenantId: null,
  externalWorkspaceId: 'AC000abc',
  metadata: {},
  ...overrides,
});

const twilioTenantIntegration = (overrides: Record<string, any> = {}) => ({
  id: INT_ID,
  workspaceId: WS,
  provider: ProviderType.TWILIO,
  scopeType: 'TENANT',
  ownerTenantId: TENANT,
  externalWorkspaceId: 'AC000abc',
  metadata: {},
  ...overrides,
});

const twilioTpn = (overrides: Record<string, any> = {}) => ({
  id: TPN_ID,
  workspaceId: WS,
  tenantId: TENANT,
  phoneNumber: PHONE,
  provider: 'twilio',
  communicationIntegrationId: INT_ID,
  ...overrides,
});

// -----------------------------------------------------------------------
// Rule 1 — by_number
// -----------------------------------------------------------------------
describe('ProviderContextResolver — rule 1 by_number', () => {
  it('resolves via tenantPhoneNumberId', async () => {
    const { svc, integrationRepo, tpnRepo, emitted } = build();
    tpnRepo.findOne.mockResolvedValue(twilioTpn());
    integrationRepo.findOne.mockResolvedValue(twilioIntegration());

    const ctx = await svc.resolve({
      workspaceId: WS,
      provider: ProviderType.TWILIO,
      tenantPhoneNumberId: TPN_ID,
    });

    expect(ctx.rule).toBe('by_number');
    expect(ctx.integration.id).toBe(INT_ID);
    expect(emitted.some((e) => e.event === 'provider_context_resolved_by_number')).toBe(true);
  });

  it('resolves via fromNumber (E.164)', async () => {
    const { svc, integrationRepo, tpnRepo } = build();
    // Only fromNumber supplied — one findOne call by phone.
    tpnRepo.findOne.mockResolvedValue(twilioTpn());
    integrationRepo.findOne.mockResolvedValue(twilioIntegration());

    const ctx = await svc.resolve({
      workspaceId: WS,
      provider: ProviderType.TWILIO,
      fromNumber: PHONE,
    });

    expect(ctx.rule).toBe('by_number');
    expect(ctx.integration.id).toBe(INT_ID);
  });

  it('falls through when TPN has no integration_id stamped (legacy)', async () => {
    const { svc, integrationRepo, tpnRepo } = build();
    tpnRepo.findOne.mockResolvedValue(twilioTpn({ communicationIntegrationId: null }));
    // Rule 3 fires (tenantId supplied)
    integrationRepo.find.mockResolvedValueOnce([
      twilioTenantIntegration(),
    ]);

    const ctx = await svc.resolve({
      workspaceId: WS,
      provider: ProviderType.TWILIO,
      tenantPhoneNumberId: TPN_ID,
      tenantId: TENANT,
    });

    expect(ctx.rule).toBe('by_tenant');
  });

  it('rejects cross-tenant TPN when caller tenantId differs', async () => {
    const { svc, tpnRepo, emitted } = build();
    tpnRepo.findOne.mockResolvedValue(twilioTpn({ tenantId: OTHER_TENANT }));

    await expect(
      svc.resolve({
        workspaceId: WS,
        provider: ProviderType.TWILIO,
        tenantPhoneNumberId: TPN_ID,
        tenantId: TENANT,
      }),
    ).rejects.toThrow(ForbiddenException);

    expect(
      emitted.some((e) => e.event === 'provider_context_cross_tenant_denied'),
    ).toBe(true);
  });

  it('does NOT reject when caller omits tenantId (shared-sender case)', async () => {
    const { svc, integrationRepo, tpnRepo } = build();
    tpnRepo.findOne.mockResolvedValue(twilioTpn({ tenantId: OTHER_TENANT }));
    integrationRepo.findOne.mockResolvedValue(twilioIntegration());

    const ctx = await svc.resolve({
      workspaceId: WS,
      provider: ProviderType.TWILIO,
      tenantPhoneNumberId: TPN_ID,
    });

    expect(ctx.rule).toBe('by_number');
  });
});

// -----------------------------------------------------------------------
// Rule 2 — by_stamped_resource
// -----------------------------------------------------------------------
describe('ProviderContextResolver — rule 2 by_stamped_resource', () => {
  it('resolves via CommunicationCall.communicationIntegrationId column', async () => {
    const { svc, callRepo, integrationRepo, emitted } = build();
    callRepo.findOne.mockResolvedValue({
      providerCallId: CALL_SID,
      communicationIntegrationId: INT_ID,
      metadata: {},
    });
    integrationRepo.findOne.mockResolvedValue(twilioIntegration());

    const ctx = await svc.resolve({
      workspaceId: WS,
      provider: ProviderType.TWILIO,
      providerResourceSid: CALL_SID,
    });

    expect(ctx.rule).toBe('by_stamped_resource');
    expect(emitted.some((e) => e.event === 'provider_context_resolved_by_resource')).toBe(true);
  });

  it('falls back to metadata.integrationId when column NULL (legacy row)', async () => {
    const { svc, callRepo, integrationRepo } = build();
    callRepo.findOne.mockResolvedValue({
      providerCallId: CALL_SID,
      communicationIntegrationId: null,
      metadata: { integrationId: INT_ID },
    });
    integrationRepo.findOne.mockResolvedValue(twilioIntegration());

    const ctx = await svc.resolve({
      workspaceId: WS,
      provider: ProviderType.TWILIO,
      providerResourceSid: CALL_SID,
    });

    expect(ctx.rule).toBe('by_stamped_resource');
  });

  it('never emits full SID (redacts to first 4 chars)', async () => {
    const { svc, callRepo, integrationRepo, emitted } = build();
    callRepo.findOne.mockResolvedValue({
      providerCallId: CALL_SID,
      communicationIntegrationId: INT_ID,
      metadata: {},
    });
    integrationRepo.findOne.mockResolvedValue(twilioIntegration());

    await svc.resolve({
      workspaceId: WS,
      provider: ProviderType.TWILIO,
      providerResourceSid: CALL_SID,
    });

    for (const e of emitted) {
      expect(JSON.stringify(e)).not.toContain(CALL_SID);
    }
  });
});

// -----------------------------------------------------------------------
// Rule 3 — by_tenant
// -----------------------------------------------------------------------
describe('ProviderContextResolver — rule 3 by_tenant', () => {
  it('resolves when exactly one TENANT-scoped integration exists', async () => {
    const { svc, integrationRepo, emitted } = build();
    integrationRepo.find.mockResolvedValue([twilioTenantIntegration()]);

    const ctx = await svc.resolve({
      workspaceId: WS,
      provider: ProviderType.TWILIO,
      tenantId: TENANT,
    });

    expect(ctx.rule).toBe('by_tenant');
    expect(ctx.integration.id).toBe(INT_ID);
    expect(emitted.some((e) => e.event === 'provider_context_resolved_by_tenant')).toBe(true);
  });

  it('throws Conflict when multiple TENANT-scoped rows match', async () => {
    const { svc, integrationRepo, emitted } = build();
    integrationRepo.find.mockResolvedValueOnce([
      twilioTenantIntegration({ id: 'a' }),
      twilioTenantIntegration({ id: 'b' }),
    ]);

    await expect(
      svc.resolve({
        workspaceId: WS,
        provider: ProviderType.TWILIO,
        tenantId: TENANT,
      }),
    ).rejects.toThrow(ConflictException);

    expect(
      emitted.some((e) => e.event === 'provider_context_ambiguous'),
    ).toBe(true);
  });

  it('falls through to rule 4 when no TENANT-scoped rows match', async () => {
    const { svc, integrationRepo } = build();
    integrationRepo.find.mockResolvedValueOnce([]); // rule 3
    integrationRepo.find.mockResolvedValueOnce([twilioIntegration()]); // rule 4

    const ctx = await svc.resolve({
      workspaceId: WS,
      provider: ProviderType.TWILIO,
      tenantId: TENANT,
    });

    expect(ctx.rule).toBe('by_legacy_workspace_fallback');
  });
});

// -----------------------------------------------------------------------
// Rule 4 — by_legacy_workspace_fallback
// -----------------------------------------------------------------------
describe('ProviderContextResolver — rule 4 by_legacy_workspace_fallback', () => {
  it('resolves in compatibility mode when exactly one integration exists', async () => {
    const { svc, integrationRepo, emitted } = build('compatibility');
    integrationRepo.find.mockResolvedValueOnce([twilioIntegration()]);

    const ctx = await svc.resolve({
      workspaceId: WS,
      provider: ProviderType.TWILIO,
    });

    expect(ctx.rule).toBe('by_legacy_workspace_fallback');
    expect(ctx.legacyFallback).toBe(true);
    expect(
      emitted.some((e) => e.event === 'provider_context_legacy_fallback'),
    ).toBe(true);
  });

  it('fails closed in strict mode even with exactly one integration', async () => {
    const { svc, integrationRepo, emitted } = build('strict');
    integrationRepo.find.mockResolvedValueOnce([twilioIntegration()]);

    await expect(
      svc.resolve({
        workspaceId: WS,
        provider: ProviderType.TWILIO,
      }),
    ).rejects.toThrow(ForbiddenException);

    expect(
      emitted.some((e) => e.event === 'provider_context_ambiguous'),
    ).toBe(true);
  });

  it('throws Conflict when >1 integration in compatibility mode', async () => {
    const { svc, integrationRepo, emitted } = build('compatibility');
    integrationRepo.find.mockResolvedValueOnce([
      twilioIntegration({ id: 'a' }),
      twilioIntegration({ id: 'b' }),
    ]);

    await expect(
      svc.resolve({
        workspaceId: WS,
        provider: ProviderType.TWILIO,
      }),
    ).rejects.toThrow(ConflictException);

    expect(
      emitted.some((e) => e.event === 'provider_context_ambiguous'),
    ).toBe(true);
  });

  it('throws NotFound when zero integrations exist', async () => {
    const { svc, integrationRepo } = build('compatibility');
    integrationRepo.find.mockResolvedValueOnce([]);

    await expect(
      svc.resolve({
        workspaceId: WS,
        provider: ProviderType.TWILIO,
      }),
    ).rejects.toThrow(NotFoundException);
  });
});

// -----------------------------------------------------------------------
// Cross-cutting — integrationId hint validation
// -----------------------------------------------------------------------
describe('ProviderContextResolver — integrationId hint', () => {
  it('passes when hint matches resolved integration', async () => {
    const { svc, integrationRepo, tpnRepo } = build();
    tpnRepo.findOne.mockResolvedValue(twilioTpn());
    integrationRepo.findOne.mockResolvedValue(twilioIntegration());

    const ctx = await svc.resolve({
      workspaceId: WS,
      provider: ProviderType.TWILIO,
      tenantPhoneNumberId: TPN_ID,
      integrationId: INT_ID,
    });

    expect(ctx.integration.id).toBe(INT_ID);
  });

  it('rejects with 403 when hint mismatches resolved', async () => {
    const { svc, integrationRepo, tpnRepo, emitted } = build();
    tpnRepo.findOne.mockResolvedValue(twilioTpn());
    integrationRepo.findOne.mockResolvedValue(twilioIntegration());

    await expect(
      svc.resolve({
        workspaceId: WS,
        provider: ProviderType.TWILIO,
        tenantPhoneNumberId: TPN_ID,
        integrationId: OTHER_INT_ID,
      }),
    ).rejects.toThrow(ForbiddenException);

    expect(
      emitted.some(
        (e) =>
          e.event === 'provider_context_mismatch' &&
          e.reason === 'caller_hint_mismatch',
      ),
    ).toBe(true);
  });
});

// -----------------------------------------------------------------------
// Cross-cutting — provider mismatch on resolved integration
// -----------------------------------------------------------------------
describe('ProviderContextResolver — provider mismatch', () => {
  it('throws 409 when resolved integration provider != requested provider', async () => {
    const { svc, integrationRepo, tpnRepo, emitted } = build();
    tpnRepo.findOne.mockResolvedValue(twilioTpn());
    integrationRepo.findOne.mockResolvedValue(
      twilioIntegration({ provider: ProviderType.OPENPHONE }),
    );

    await expect(
      svc.resolve({
        workspaceId: WS,
        provider: ProviderType.TWILIO,
        tenantPhoneNumberId: TPN_ID,
      }),
    ).rejects.toThrow(ConflictException);

    expect(
      emitted.some(
        (e) =>
          e.event === 'provider_context_mismatch' &&
          e.reason === 'provider_mismatch',
      ),
    ).toBe(true);
  });
});

// -----------------------------------------------------------------------
// Cross-cutting — required inputs
// -----------------------------------------------------------------------
describe('ProviderContextResolver — required inputs', () => {
  it('throws when workspaceId missing', async () => {
    const { svc } = build();
    await expect(
      svc.resolve({
        workspaceId: '' as any,
        provider: ProviderType.TWILIO,
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('throws when provider missing', async () => {
    const { svc } = build();
    await expect(
      svc.resolve({
        workspaceId: WS,
        provider: '' as any,
      }),
    ).rejects.toThrow(ForbiddenException);
  });
});

// -----------------------------------------------------------------------
// Mode selection
// -----------------------------------------------------------------------
describe('ProviderContextResolver — mode selection', () => {
  it('defaults to compatibility when env var unset', () => {
    const { svc } = build();
    expect(svc.getMode()).toBe('compatibility');
  });

  it('reads strict when env var set to strict', () => {
    const { svc } = build('strict');
    expect(svc.getMode()).toBe('strict');
  });

  it('accepts compatibility explicitly', () => {
    const { svc } = build('compatibility');
    expect(svc.getMode()).toBe('compatibility');
  });

  it('honors modeOverride per-call for tests', async () => {
    const { svc, integrationRepo } = build('compatibility');
    integrationRepo.find.mockResolvedValueOnce([twilioIntegration()]);

    // With compat mode default + override to strict, rule 4 should fail.
    await expect(
      svc.resolve({
        workspaceId: WS,
        provider: ProviderType.TWILIO,
        modeOverride: 'strict',
      }),
    ).rejects.toThrow(ForbiddenException);
  });
});

// -----------------------------------------------------------------------
// Rule priority — earlier rule wins even when later rules would match
// -----------------------------------------------------------------------
describe('ProviderContextResolver — rule priority', () => {
  it('rule 1 wins over rule 2 when both would resolve', async () => {
    const { svc, integrationRepo, tpnRepo, callRepo } = build();
    tpnRepo.findOne.mockResolvedValue(twilioTpn());
    integrationRepo.findOne.mockResolvedValue(twilioIntegration());
    // callRepo would be consulted if rule 1 failed; ensure it's NOT called.
    callRepo.findOne.mockResolvedValue({
      providerCallId: CALL_SID,
      communicationIntegrationId: OTHER_INT_ID,
    });

    const ctx = await svc.resolve({
      workspaceId: WS,
      provider: ProviderType.TWILIO,
      tenantPhoneNumberId: TPN_ID,
      providerResourceSid: CALL_SID,
    });

    expect(ctx.rule).toBe('by_number');
    expect(callRepo.findOne).not.toHaveBeenCalled();
  });

  it('rule 3 wins over rule 4 when tenant-scoped row exists', async () => {
    const { svc, integrationRepo } = build();
    integrationRepo.find.mockResolvedValueOnce([twilioTenantIntegration()]);

    const ctx = await svc.resolve({
      workspaceId: WS,
      provider: ProviderType.TWILIO,
      tenantId: TENANT,
    });

    expect(ctx.rule).toBe('by_tenant');
    // rule 4 find was not called
    expect(integrationRepo.find).toHaveBeenCalledTimes(1);
  });
});
