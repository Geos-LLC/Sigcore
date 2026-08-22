/**
 * Adversarial tests for the CSC (Call-Scoped Capability) branch of
 * IntegrationResourceGuard — G-6, systemic-provisioning milestone,
 * post-security-review 2026-08-22.
 *
 * The capability-only utility surface is exercised in
 * `call-scoped-capability.util.spec.ts` (27 cases). This spec pins the
 * guard's DB-integration behavior end-to-end:
 *
 *   1. Capability + call.metadata.integrationId match → allow, resolve
 *      workspace from the integration itself (NOT from request header).
 *   2. Capability integration mismatch (capability.integrationId ≠ call
 *      stamped) → 403.
 *   3. Call missing → 403.
 *   4. Call has no stamped integrationId (pre-Wave-4 legacy) → 403 (CSC
 *      requires the stamp).
 *   5. Integration deleted after capability minted → 403.
 *   6. Endpoint has no operation declared but capability header present
 *      → 403 (safety: never under-scope authorization).
 *   7. Capability header on TPN-kind endpoint → 400 (client bug).
 *   8. No capability header → falls through to workspace-scoped path
 *      (backward-compat).
 */
import { ExecutionContext, ForbiddenException, BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { IntegrationResourceGuard } from './integration-resource.guard';
import { IntegrationResourceGuardService } from './integration-resource-guard.service';
import {
  INTEGRATION_RESOURCE_KEY,
  INTEGRATION_RESOURCE_OPERATION_KEY,
} from './use-integration-resource-guard.decorator';
import {
  mintCallCapability,
  CSC_HEADER_NAME,
} from './call-scoped-capability.util';

const SIGCORE_SECRET = 'sigcore-only-secret-32-bytes-!!!!!!!!';
const CALL_SID = 'CAbeefbeefbeefbeefbeefbeefbeefbeef';
const CALL_INTEGRATION = 'a537cc3a-5c62-4f11-aff8-50fa840ef7a2';
const OTHER_INTEGRATION = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const LB_WORKSPACE = '1bcbb4e0-df1b-481c-83ba-0730df47a720';
const LB_TENANT = '38380c75-1876-4984-b194-5fda7529835c';
const DEFAULT_EXP_S = Math.floor(Date.now() / 1000) + 4 * 3600;

function makeCtx(overrides: {
  kind?: string | null;
  operation?: string | null;
  headers?: Record<string, string>;
  params?: Record<string, string>;
  body?: Record<string, unknown>;
} = {}) {
  const request = {
    params: overrides.params ?? { providerCallSid: CALL_SID },
    body: overrides.body ?? {},
    headers: overrides.headers ?? {},
    workspaceId: 'caller-workspace',
    tenantId: null,
    authType: 'api_key',
    authScopeType: 'workspace',
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
  const reflector = {
    getAllAndOverride: jest.fn((key: string) => {
      if (key === INTEGRATION_RESOURCE_KEY) return overrides.kind ?? 'providerCallSid';
      if (key === INTEGRATION_RESOURCE_OPERATION_KEY) return overrides.operation ?? 'call.hangup';
      return undefined;
    }),
  } as unknown as Reflector;
  return { context, request, reflector };
}

function makeGuard(opts: {
  reflector: Reflector;
  secret?: string | null;
  call?: unknown;
  integration?: unknown;
  svcAssert?: jest.Mock;
}) {
  const svc = {
    assert: opts.svcAssert ?? jest.fn(async () => ({
      workspaceId: 'legacy-workspace',
      tenantId: 'legacy-tenant',
      integration: { id: 'legacy-integration' },
    })),
  } as unknown as IntegrationResourceGuardService;
  const config = {
    get: jest.fn((k: string) => (k === 'SIGCORE_CALL_CAPABILITY_SECRET' ? opts.secret ?? SIGCORE_SECRET : undefined)),
  } as unknown as ConfigService;
  const callRepo = {
    findOne: jest.fn(async () => opts.call ?? null),
  } as any;
  const integrationRepo = {
    findOne: jest.fn(async () => opts.integration ?? null),
  } as any;
  return {
    guard: new IntegrationResourceGuard(opts.reflector, svc, config, callRepo, integrationRepo),
    svcAssert: svc.assert as jest.Mock,
    callRepo,
    integrationRepo,
  };
}

describe('IntegrationResourceGuard — CSC happy path', () => {
  it('accepts a Sigcore-minted capability, resolves workspace/tenant from the integration, attaches request.resource', async () => {
    const cap = mintCallCapability({
      callSid: CALL_SID,
      integrationId: CALL_INTEGRATION,
      allowedOps: ['call.hangup', 'call.recording.start', 'call.recording.stop'],
      expUnixSeconds: DEFAULT_EXP_S,
      secret: SIGCORE_SECRET,
    });
    const { context, request, reflector } = makeCtx({
      operation: 'call.hangup',
      headers: { [CSC_HEADER_NAME]: cap },
    });
    const { guard, svcAssert } = makeGuard({
      reflector,
      call: {
        providerCallId: CALL_SID,
        metadata: { integrationId: CALL_INTEGRATION },
      },
      integration: {
        id: CALL_INTEGRATION,
        workspaceId: LB_WORKSPACE,
        ownerTenantId: LB_TENANT,
        metadata: {},
      },
    });
    const ok = await guard.canActivate(context);
    expect(ok).toBe(true);
    expect((request as any).resource).toEqual(
      expect.objectContaining({
        workspaceId: LB_WORKSPACE,
        tenantId: LB_TENANT,
      }),
    );
    // Legacy path MUST NOT have fired — CSC is authoritative when header
    // is present.
    expect(svcAssert).not.toHaveBeenCalled();
  });
});

describe('IntegrationResourceGuard — CSC integration mismatch (adversarial)', () => {
  it('rejects when capability.integrationId does not match call.metadata.integrationId', async () => {
    // The capability is a valid Sigcore-minted capability, but for a
    // DIFFERENT integration than the one that actually owns this call.
    // Defense in depth: even a valid capability must match ground truth.
    const cap = mintCallCapability({
      callSid: CALL_SID,
      integrationId: OTHER_INTEGRATION,
      allowedOps: ['call.hangup'],
      expUnixSeconds: DEFAULT_EXP_S,
      secret: SIGCORE_SECRET,
    });
    const { context, reflector } = makeCtx({
      operation: 'call.hangup',
      headers: { [CSC_HEADER_NAME]: cap },
    });
    const { guard } = makeGuard({
      reflector,
      call: {
        providerCallId: CALL_SID,
        metadata: { integrationId: CALL_INTEGRATION },
      },
    });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects when call resource does not exist', async () => {
    const cap = mintCallCapability({
      callSid: CALL_SID,
      integrationId: CALL_INTEGRATION,
      allowedOps: ['call.hangup'],
      expUnixSeconds: DEFAULT_EXP_S,
      secret: SIGCORE_SECRET,
    });
    const { context, reflector } = makeCtx({
      operation: 'call.hangup',
      headers: { [CSC_HEADER_NAME]: cap },
    });
    const { guard } = makeGuard({ reflector, call: null });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects when call row exists but has no stamped integrationId (pre-Wave-4)', async () => {
    const cap = mintCallCapability({
      callSid: CALL_SID,
      integrationId: CALL_INTEGRATION,
      allowedOps: ['call.hangup'],
      expUnixSeconds: DEFAULT_EXP_S,
      secret: SIGCORE_SECRET,
    });
    const { context, reflector } = makeCtx({
      operation: 'call.hangup',
      headers: { [CSC_HEADER_NAME]: cap },
    });
    const { guard } = makeGuard({
      reflector,
      call: {
        providerCallId: CALL_SID,
        metadata: {},
      },
    });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects when integration row is deleted after capability minted', async () => {
    const cap = mintCallCapability({
      callSid: CALL_SID,
      integrationId: CALL_INTEGRATION,
      allowedOps: ['call.hangup'],
      expUnixSeconds: DEFAULT_EXP_S,
      secret: SIGCORE_SECRET,
    });
    const { context, reflector } = makeCtx({
      operation: 'call.hangup',
      headers: { [CSC_HEADER_NAME]: cap },
    });
    const { guard } = makeGuard({
      reflector,
      call: {
        providerCallId: CALL_SID,
        metadata: { integrationId: CALL_INTEGRATION },
      },
      integration: null,
    });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('IntegrationResourceGuard — CSC capability-authenticity failures (util-layer passes through)', () => {
  it('rejects a capability signed with the wrong secret (Callio-cannot-mint at the guard level)', async () => {
    const cap = mintCallCapability({
      callSid: CALL_SID,
      integrationId: CALL_INTEGRATION,
      allowedOps: ['call.hangup'],
      expUnixSeconds: DEFAULT_EXP_S,
      secret: 'attacker-guess-secret',
    });
    const { context, reflector } = makeCtx({
      operation: 'call.hangup',
      headers: { [CSC_HEADER_NAME]: cap },
    });
    const { guard } = makeGuard({ reflector, secret: SIGCORE_SECRET });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a capability whose allowedOps do not include the endpoint operation', async () => {
    const cap = mintCallCapability({
      callSid: CALL_SID,
      integrationId: CALL_INTEGRATION,
      allowedOps: ['call.hangup'], // no recording.start
      expUnixSeconds: DEFAULT_EXP_S,
      secret: SIGCORE_SECRET,
    });
    const { context, reflector } = makeCtx({
      operation: 'call.recording.start',
      headers: { [CSC_HEADER_NAME]: cap },
    });
    const { guard } = makeGuard({ reflector });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a capability from a different call (cross-call replay)', async () => {
    const cap = mintCallCapability({
      callSid: 'CAother',
      integrationId: CALL_INTEGRATION,
      allowedOps: ['call.hangup'],
      expUnixSeconds: DEFAULT_EXP_S,
      secret: SIGCORE_SECRET,
    });
    const { context, reflector } = makeCtx({
      operation: 'call.hangup',
      headers: { [CSC_HEADER_NAME]: cap },
    });
    const { guard } = makeGuard({ reflector });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('IntegrationResourceGuard — CSC endpoint-safety', () => {
  it('rejects with 403 when the endpoint did not declare an operation', async () => {
    const cap = mintCallCapability({
      callSid: CALL_SID,
      integrationId: CALL_INTEGRATION,
      allowedOps: ['call.hangup'],
      expUnixSeconds: DEFAULT_EXP_S,
      secret: SIGCORE_SECRET,
    });
    const { context, reflector } = makeCtx({
      operation: null,
      headers: { [CSC_HEADER_NAME]: cap },
    });
    const { guard } = makeGuard({ reflector });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects with 400 when a CSC capability lands on a TPN-kind endpoint (client bug)', async () => {
    const cap = mintCallCapability({
      callSid: CALL_SID,
      integrationId: CALL_INTEGRATION,
      allowedOps: ['call.hangup'],
      expUnixSeconds: DEFAULT_EXP_S,
      secret: SIGCORE_SECRET,
    });
    const { context, reflector } = makeCtx({
      kind: 'tpnId',
      operation: 'call.hangup',
      headers: { [CSC_HEADER_NAME]: cap },
      params: { tpnId: 'some-tpn' },
    });
    const { guard } = makeGuard({ reflector });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('IntegrationResourceGuard — backward compat (no capability header → legacy path)', () => {
  it('falls through to legacy workspace-scoped path when no capability header is present', async () => {
    const { context, request, reflector } = makeCtx({
      body: { integrationId: 'legacy-integration' },
    });
    const legacyAssert = jest.fn(async () => ({
      workspaceId: 'legacy-workspace',
      tenantId: 'legacy-tenant',
      integration: { id: 'legacy-integration' },
    }));
    const { guard } = makeGuard({ reflector, svcAssert: legacyAssert });
    const ok = await guard.canActivate(context);
    expect(ok).toBe(true);
    expect(legacyAssert).toHaveBeenCalledTimes(1);
    expect((request as any).resource).toEqual(
      expect.objectContaining({
        workspaceId: 'legacy-workspace',
        tenantId: 'legacy-tenant',
      }),
    );
  });

  it('legacy path rejects with 400 when integrationId is missing (behavior unchanged)', async () => {
    const { context, reflector } = makeCtx({ body: {} });
    const { guard } = makeGuard({ reflector });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(BadRequestException);
  });
});
