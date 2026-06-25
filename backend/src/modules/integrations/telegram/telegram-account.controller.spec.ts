import { Test, TestingModule } from '@nestjs/testing';
import { TelegramAccountController } from './telegram-account.controller';
import { TelegramPublisherService } from './telegram-publisher.service';

describe('TelegramAccountController', () => {
  let controller: TelegramAccountController;
  let svc: jest.Mocked<TelegramPublisherService>;

  beforeEach(async () => {
    svc = {
      startAccountLink: jest.fn().mockResolvedValue({
        subscription: { status: 'ready', mode: 'account', linkStatus: 'code_requested', tgUserId: null, tgUsername: null, lastSyncedAt: '2026-07-01T00:00:00Z' },
        nextStep: 'code',
      }),
      submitAccountCode: jest.fn().mockResolvedValue({
        subscription: { status: 'ready', mode: 'account', linkStatus: 'linked', tgUserId: '123', tgUsername: '@x', lastSyncedAt: '2026-07-01T00:00:00Z' },
        nextStep: 'linked',
      }),
      submitAccountPassword: jest.fn().mockResolvedValue({
        subscription: { status: 'ready', mode: 'account', linkStatus: 'linked', tgUserId: '123', tgUsername: '@x', lastSyncedAt: '2026-07-01T00:00:00Z' },
        nextStep: 'linked',
      }),
      resendAccountCode: jest.fn().mockResolvedValue({ ok: true, subscription: {} as any }),
      deleteAccount: jest.fn().mockResolvedValue({ ok: true }),
    } as any;

    const mod: TestingModule = await Test.createTestingModule({
      controllers: [TelegramAccountController],
      providers: [{ provide: TelegramPublisherService, useValue: svc }],
    })
      .overrideGuard(require('../../auth/sigcore-auth.guard').SigcoreAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = mod.get(TelegramAccountController);
  });

  it('start forwards workspaceId + tenantId + payload', async () => {
    await controller.start('ws-1', 'tenant-1', {
      phoneNumber: '+19185551234',
      riskAcknowledged: true,
    } as any);
    expect(svc.startAccountLink).toHaveBeenCalledWith('ws-1', 'tenant-1', {
      phoneNumber: '+19185551234',
      password: undefined,
      riskAcknowledged: true,
    });
  });

  it('start normalises null tenantId to undefined', async () => {
    await controller.start('ws-1', null, { phoneNumber: '+1', riskAcknowledged: true } as any);
    expect(svc.startAccountLink).toHaveBeenCalledWith('ws-1', undefined, expect.any(Object));
  });

  it('code passes through', async () => {
    await controller.code('ws-1', { code: '12345' } as any);
    expect(svc.submitAccountCode).toHaveBeenCalledWith('ws-1', '12345');
  });

  it('password passes through', async () => {
    await controller.password('ws-1', { password: 's3cret' } as any);
    expect(svc.submitAccountPassword).toHaveBeenCalledWith('ws-1', 's3cret');
  });

  it('resend has no body', async () => {
    await controller.resend('ws-1');
    expect(svc.resendAccountCode).toHaveBeenCalledWith('ws-1');
  });

  it('unlink calls deleteAccount', async () => {
    const r = await controller.unlink('ws-1');
    expect(svc.deleteAccount).toHaveBeenCalledWith('ws-1');
    expect(r).toEqual({ ok: true });
  });
});
