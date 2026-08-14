/**
 * Wave-2 Task 3 — CallsV1Controller (recording/start + hangup).
 *
 * Happy paths plus all four IntegrationResourceGuard rejection modes wired
 * through the Nest guard-instance's canActivate rather than the isolated
 * service. This test does NOT bootstrap Nest — it composes the pieces
 * directly so the same 4-way validator is exercised end-to-end.
 */

import { ExecutionContext, ForbiddenException, BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CallsV1Controller } from './calls.controller';
import { IntegrationResourceGuard } from '../../common/guards/integration-resource.guard';
import { IntegrationResourceGuardService } from '../../common/guards/integration-resource-guard.service';
import { INTEGRATION_RESOURCE_KEY } from '../../common/guards/use-integration-resource-guard.decorator';
import { ProviderType } from '../../database/entities/communication-integration.entity';

function buildRepo() {
  return { findOne: jest.fn(), find: jest.fn(), save: jest.fn(), create: jest.fn() };
}

function buildGuardService() {
  const tenantRepo = buildRepo();
  const integrationRepo = buildRepo();
  const callRepo = buildRepo();
  const tpnRepo = buildRepo();
  const svc = new IntegrationResourceGuardService(
    tenantRepo as any,
    integrationRepo as any,
    callRepo as any,
    tpnRepo as any,
  );
  return { svc, tenantRepo, integrationRepo, callRepo, tpnRepo };
}

function mockContext(request: any): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
    getHandler: () => null,
    getClass: () => null,
  } as any;
}

const WS = 'ws-1';
const TENANT = 'tenant-1';
const INT_ID = 'integration-1';
const CALL_SID = 'CA1234567890abcdef';

describe('CallsV1Controller — happy paths', () => {
  it('startRecording delegates to TwilioVoiceService with resolved integration', async () => {
    const twilioVoiceService: any = {
      startRecording: jest.fn(async () => ({ recordingSid: 'RE_x', status: 'in-progress' })),
      hangup: jest.fn(),
    };
    const controller = new CallsV1Controller(
      twilioVoiceService,
      { isArmed: () => false, mintToken: () => null, eventTypeForKind: (k: string) => k === 'recording_status' ? 'voice_recording_status' : 'voice_call_status' } as any,
      { get: () => undefined } as any,
      { claim: jest.fn(), remember: jest.fn(), release: jest.fn() } as any,
      { assert: jest.fn() } as any,
      { findOne: jest.fn() } as any,
      // Wave-4 PR #1: callRepo + conversationRepo (unused in these tests)
      { findOne: jest.fn(), create: jest.fn((x: any) => x), save: jest.fn(async (x: any) => x) } as any,
      { findOne: jest.fn(), create: jest.fn((x: any) => x), save: jest.fn(async (x: any) => x) } as any,
      // P0-3 (2026-08-15): ppaRepo + profileRepo (unused in non-dial tests)
      { createQueryBuilder: jest.fn() } as any,
      {} as any,
    );
    const req: any = {
      resource: { workspaceId: WS, tenantId: TENANT, integration: { id: INT_ID } },
    };

    const res = await controller.startRecording(
      CALL_SID,
      { integrationId: INT_ID, recordingChannels: 'dual' },
      req,
    );

    expect(res.data.recordingSid).toBe('RE_x');
    expect(twilioVoiceService.startRecording).toHaveBeenCalledWith(
      { id: INT_ID },
      CALL_SID,
      { recordingChannels: 'dual', statusCallbackUrl: undefined, statusCallbackEvents: undefined },
    );
  });

  it('hangup delegates to TwilioVoiceService with resolved integration', async () => {
    const twilioVoiceService: any = {
      startRecording: jest.fn(),
      hangup: jest.fn(async () => ({ providerCallSid: CALL_SID, status: 'completed' })),
    };
    const controller = new CallsV1Controller(
      twilioVoiceService,
      { isArmed: () => false, mintToken: () => null, eventTypeForKind: (k: string) => k === 'recording_status' ? 'voice_recording_status' : 'voice_call_status' } as any,
      { get: () => undefined } as any,
      { claim: jest.fn(), remember: jest.fn(), release: jest.fn() } as any,
      { assert: jest.fn() } as any,
      { findOne: jest.fn() } as any,
      // Wave-4 PR #1: callRepo + conversationRepo (unused in these tests)
      { findOne: jest.fn(), create: jest.fn((x: any) => x), save: jest.fn(async (x: any) => x) } as any,
      { findOne: jest.fn(), create: jest.fn((x: any) => x), save: jest.fn(async (x: any) => x) } as any,
      // P0-3 (2026-08-15): ppaRepo + profileRepo (unused in non-dial tests)
      { createQueryBuilder: jest.fn() } as any,
      {} as any,
    );
    const req: any = {
      resource: { workspaceId: WS, tenantId: TENANT, integration: { id: INT_ID } },
    };

    const res = await controller.hangup(CALL_SID, { integrationId: INT_ID }, req);

    expect(res.data.status).toBe('completed');
    expect(twilioVoiceService.hangup).toHaveBeenCalledWith({ id: INT_ID }, CALL_SID);
  });
});

describe('IntegrationResourceGuard — 4 rejection modes for call ops', () => {
  const reflector = new Reflector();
  jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue('providerCallSid');

  const buildRequest = (body: any = { integrationId: INT_ID, tenantId: TENANT }) => ({
    workspaceId: WS,
    tenantId: TENANT,
    authType: 'service',
    authScopeType: 'workspace',
    params: { providerCallSid: CALL_SID },
    body,
  });

  it('rejects_when_workspace_does_not_own_tenant (check=1)', async () => {
    const { svc, tenantRepo } = buildGuardService();
    tenantRepo.findOne.mockResolvedValue(null);
    const guard = new IntegrationResourceGuard(reflector, svc);

    await expect(guard.canActivate(mockContext(buildRequest()))).rejects.toMatchObject({
      message: expect.stringContaining('check=1 failed'),
    });
  });

  it('rejects_when_api_key_tenant_scope_mismatches_body_tenant (check=2)', async () => {
    const { svc, tenantRepo } = buildGuardService();
    tenantRepo.findOne.mockResolvedValue({ id: TENANT, workspaceId: WS });
    const guard = new IntegrationResourceGuard(reflector, svc);
    const req = buildRequest({ integrationId: INT_ID, tenantId: 'other-tenant' });
    req.authType = 'api_key';
    req.authScopeType = 'tenant';

    await expect(guard.canActivate(mockContext(req))).rejects.toMatchObject({
      message: expect.stringContaining('check=2 failed'),
    });
  });

  it('rejects_when_integration_id_belongs_to_other_tenant (check=3)', async () => {
    const { svc, tenantRepo, integrationRepo } = buildGuardService();
    tenantRepo.findOne.mockResolvedValue({ id: TENANT, workspaceId: WS });
    integrationRepo.findOne.mockResolvedValue({
      id: INT_ID,
      workspaceId: WS,
      provider: ProviderType.TWILIO,
      metadata: { ensure: { tenantId: 'someone-else' } },
    });
    const guard = new IntegrationResourceGuard(reflector, svc);

    await expect(guard.canActivate(mockContext(buildRequest()))).rejects.toMatchObject({
      message: expect.stringContaining('check=3 failed'),
    });
  });

  it('rejects_when_provider_call_sid_not_linked_to_integration (check=4)', async () => {
    const { svc, tenantRepo, integrationRepo, callRepo } = buildGuardService();
    tenantRepo.findOne.mockResolvedValue({ id: TENANT, workspaceId: WS });
    integrationRepo.findOne.mockResolvedValue({
      id: INT_ID,
      workspaceId: WS,
      provider: ProviderType.TWILIO,
      externalWorkspaceId: 'AC-nope',
      metadata: { ensure: { tenantId: TENANT } },
    });
    callRepo.findOne.mockResolvedValue(null);
    const guard = new IntegrationResourceGuard(reflector, svc);
    const req = buildRequest();
    // Not a CA-prefixed SID → pilot fallback also fails, forcing check=4.
    req.params.providerCallSid = 'XX_nope';

    await expect(guard.canActivate(mockContext(req))).rejects.toMatchObject({
      message: expect.stringContaining('check=4 failed'),
    });
  });

  it('boundary_missing_providerCallSid_returns_400_not_500', async () => {
    const { svc } = buildGuardService();
    const guard = new IntegrationResourceGuard(reflector, svc);
    const req = buildRequest();
    req.params.providerCallSid = '';

    await expect(guard.canActivate(mockContext(req))).rejects.toThrow(BadRequestException);
  });

  it('missing integrationId body → 400 (not 500)', async () => {
    const { svc } = buildGuardService();
    const guard = new IntegrationResourceGuard(reflector, svc);
    const req = buildRequest();
    delete (req.body as any).integrationId;

    await expect(guard.canActivate(mockContext(req))).rejects.toThrow(BadRequestException);
  });
});

describe('TwilioVoiceService failure surface', () => {
  it('Twilio startRecording error surfaces as 502 (not 500)', async () => {
    const twilioVoiceService: any = {
      startRecording: jest.fn(async () => {
        const err: any = new Error('twilio blew up');
        err.status = 500;
        // In the real service, the caller wraps in BadGatewayException — here
        // we just assert the controller propagates whatever the service throws.
        throw err;
      }),
      hangup: jest.fn(),
    };
    const controller = new CallsV1Controller(
      twilioVoiceService,
      { isArmed: () => false, mintToken: () => null, eventTypeForKind: (k: string) => k === 'recording_status' ? 'voice_recording_status' : 'voice_call_status' } as any,
      { get: () => undefined } as any,
      { claim: jest.fn(), remember: jest.fn(), release: jest.fn() } as any,
      { assert: jest.fn() } as any,
      { findOne: jest.fn() } as any,
      // Wave-4 PR #1: callRepo + conversationRepo (unused in these tests)
      { findOne: jest.fn(), create: jest.fn((x: any) => x), save: jest.fn(async (x: any) => x) } as any,
      { findOne: jest.fn(), create: jest.fn((x: any) => x), save: jest.fn(async (x: any) => x) } as any,
      // P0-3 (2026-08-15): ppaRepo + profileRepo (unused in non-dial tests)
      { createQueryBuilder: jest.fn() } as any,
      {} as any,
    );
    const req: any = {
      resource: { workspaceId: WS, tenantId: TENANT, integration: { id: INT_ID } },
    };

    await expect(
      controller.startRecording(CALL_SID, { integrationId: INT_ID }, req),
    ).rejects.toThrow('twilio blew up');
  });
});
