import { Test, TestingModule } from '@nestjs/testing';
import { TelegramPublisherController } from './telegram-publisher.controller';
import { TelegramPublisherService } from './telegram-publisher.service';

describe('TelegramPublisherController', () => {
  let controller: TelegramPublisherController;
  let svc: jest.Mocked<TelegramPublisherService>;

  beforeEach(async () => {
    svc = {
      subscribe: jest.fn().mockResolvedValue({ botUsername: 'bot', status: 'ready' }),
      getStatus: jest.fn().mockResolvedValue({ status: 'ready', botUsername: 'bot' }),
      verifyChat: jest
        .fn()
        .mockResolvedValue({ status: 'ready', warnings: ['PAY_TO_POST_NOT_DETECTABLE'] }),
      publish: jest.fn().mockResolvedValue({ placementId: 'pl-1', status: 'queued' }),
      cancel: jest.fn().mockResolvedValue({ placementId: 'pl-1', status: 'cancelled' }),
      getPlacement: jest.fn().mockResolvedValue({ id: 'pl-1' }),
    } as any;

    const mod: TestingModule = await Test.createTestingModule({
      controllers: [TelegramPublisherController],
      providers: [{ provide: TelegramPublisherService, useValue: svc }],
    })
      .overrideGuard(require('../../auth/sigcore-auth.guard').SigcoreAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = mod.get(TelegramPublisherController);
  });

  it('subscribe wires workspaceId + tenantId + displayName (default mode=bot)', async () => {
    await controller.subscribe('ws-1', 'tenant-1', { displayName: 'My Bot' });
    expect(svc.subscribe).toHaveBeenCalledWith('ws-1', 'tenant-1', 'My Bot', 'bot');
  });

  it('subscribe normalises null tenantId to undefined', async () => {
    await controller.subscribe('ws-1', null, {});
    expect(svc.subscribe).toHaveBeenCalledWith('ws-1', undefined, undefined, 'bot');
  });

  it('subscribe respects ?mode=account query', async () => {
    await controller.subscribe('ws-1', 'tenant-1', {}, 'account');
    expect(svc.subscribe).toHaveBeenCalledWith('ws-1', 'tenant-1', undefined, 'account');
  });

  it('subscribe rejects invalid mode value', async () => {
    await expect(controller.subscribe('ws-1', 'tenant-1', {}, 'bogus' as any)).rejects.toThrow();
  });

  it('status calls service.getStatus', async () => {
    const out = await controller.status('ws-1');
    expect(svc.getStatus).toHaveBeenCalledWith('ws-1');
    expect(out.status).toBe('ready');
  });

  it('verify-chat passes probe through', async () => {
    await controller.verifyChat('ws-1', { chatRef: '@c', probe: true });
    expect(svc.verifyChat).toHaveBeenCalledWith('ws-1', '@c', true);
  });

  it('publish wires DTO', async () => {
    await controller.publish('ws-1', 'tenant-1', {
      chatRef: '@c',
      text: 'hi',
      externalRef: 'k1',
    } as any);
    expect(svc.publish).toHaveBeenCalledWith(
      'ws-1',
      'tenant-1',
      expect.objectContaining({ chatRef: '@c', text: 'hi', externalRef: 'k1' }),
    );
  });

  it('cancel calls service.cancel', async () => {
    await controller.cancel('ws-1', 'pl-1');
    expect(svc.cancel).toHaveBeenCalledWith('pl-1', 'ws-1');
  });
});
