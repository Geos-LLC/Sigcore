import { HttpException, HttpStatus } from '@nestjs/common';
import { TelegramController } from './telegram.controller';

describe('TelegramController', () => {
  const API_KEY = 'service-test-key';
  let controller: TelegramController;
  let svc: {
    provisionSubscriber: jest.Mock;
    getSubscriber: jest.Mock;
    deleteSubscriber: jest.Mock;
    verifyChat: jest.Mock;
    publish: jest.Mock;
    cancel: jest.Mock;
    startAccountLink: jest.Mock;
    submitAccountCode: jest.Mock;
    submitAccountPassword: jest.Mock;
    resendAccountCode: jest.Mock;
    getAccount: jest.Mock;
    deleteAccount: jest.Mock;
  };

  beforeEach(() => {
    process.env.SERVICE_API_KEY = API_KEY;
    svc = {
      provisionSubscriber: jest.fn().mockResolvedValue({ subscriberId: 's1', botUsername: 'b', status: 'ready' }),
      getSubscriber: jest.fn().mockResolvedValue({ subscriberId: 's1', botUsername: 'b', status: 'ready' }),
      deleteSubscriber: jest.fn().mockResolvedValue(undefined),
      verifyChat: jest.fn().mockResolvedValue({ status: 'ready', warnings: ['PAY_TO_POST_NOT_DETECTABLE'] }),
      publish: jest.fn().mockResolvedValue({ messageId: 'm1', status: 'queued' }),
      cancel: jest.fn().mockResolvedValue({ messageId: 'm1', status: 'cancelled' }),
      startAccountLink: jest.fn().mockResolvedValue({ accountId: 'acc_1', status: 'code_requested' }),
      submitAccountCode: jest.fn().mockResolvedValue({ accountId: 'acc_1', status: 'linked' }),
      submitAccountPassword: jest.fn().mockResolvedValue({ accountId: 'acc_1', status: 'linked' }),
      resendAccountCode: jest.fn().mockResolvedValue({ status: 'code_requested' }),
      getAccount: jest.fn().mockResolvedValue({ accountId: 'acc_1', status: 'linked', tgUsername: '@x' }),
      deleteAccount: jest.fn().mockResolvedValue({ status: 'unlinked' }),
    };
    controller = new TelegramController(svc as any);
  });

  it('health is unauthed', () => {
    expect(controller.health()).toEqual({ status: 'ok', service: 'sigcore-telegram' });
  });

  it('rejects bad x-api-key on /subscribers', async () => {
    await expect(
      controller.createSubscriber('wrong', { workspaceId: 'ws-1' }),
    ).rejects.toMatchObject({ status: HttpStatus.UNAUTHORIZED });
  });

  it('accepts good x-api-key on /subscribers', async () => {
    const out = await controller.createSubscriber(API_KEY, { workspaceId: 'ws-1' });
    expect(out.botUsername).toBe('b');
  });

  it('400s on missing workspaceId for verify', async () => {
    await expect(
      controller.verifyChat(API_KEY, { workspaceId: '', chatRef: '@x' }),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('400s on publish without text and imageUrl', async () => {
    await expect(
      controller.publish(API_KEY, {
        workspaceId: 'ws-1',
        chatRef: '@x',
        idempotencyKey: 'k',
      }),
    ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
  });

  it('allows publish with imageUrl only', async () => {
    const out = await controller.publish(API_KEY, {
      workspaceId: 'ws-1',
      chatRef: '@x',
      imageUrl: 'http://x/y.jpg',
      idempotencyKey: 'k',
    });
    expect(out.messageId).toBe('m1');
  });

  // ===== Account-mode routes =====

  describe('account routes', () => {
    it('startAccountLink: 400 RISK_NOT_ACKNOWLEDGED when riskAcknowledged !== true', async () => {
      await expect(
        controller.startAccountLink(API_KEY, {
          workspaceId: 'ws-1',
          phoneNumber: '+1',
          riskAcknowledged: false,
        }),
      ).rejects.toMatchObject({ status: HttpStatus.BAD_REQUEST });
      expect(svc.startAccountLink).not.toHaveBeenCalled();
    });

    it('startAccountLink: 400 missing workspaceId or phoneNumber', async () => {
      await expect(
        controller.startAccountLink(API_KEY, { workspaceId: '', phoneNumber: '+1', riskAcknowledged: true }),
      ).rejects.toBeInstanceOf(HttpException);
    });

    it('startAccountLink: forwards to service when valid', async () => {
      const out = await controller.startAccountLink(API_KEY, {
        workspaceId: 'ws-1',
        phoneNumber: '+19185551234',
        riskAcknowledged: true,
      });
      expect(svc.startAccountLink).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-1', phoneNumber: '+19185551234' }));
      expect(out.accountId).toBe('acc_1');
    });

    it('code: 401 on bad api key', async () => {
      await expect(
        controller.submitAccountCode('wrong', 'ws-1', { code: '12345' }),
      ).rejects.toMatchObject({ status: HttpStatus.UNAUTHORIZED });
    });

    it('code: 400 on missing code', async () => {
      await expect(
        controller.submitAccountCode(API_KEY, 'ws-1', { code: '' }),
      ).rejects.toBeInstanceOf(HttpException);
    });

    it('code: forwards to service', async () => {
      const out = await controller.submitAccountCode(API_KEY, 'ws-1', { code: '12345' });
      expect(svc.submitAccountCode).toHaveBeenCalledWith('ws-1', '12345');
      expect(out.status).toBe('linked');
    });

    it('password: forwards to service', async () => {
      const out = await controller.submitAccountPassword(API_KEY, 'ws-1', { password: 's3cret' });
      expect(svc.submitAccountPassword).toHaveBeenCalledWith('ws-1', 's3cret');
      expect(out.status).toBe('linked');
    });

    it('resend-code: forwards to service', async () => {
      const out = await controller.resendAccountCode(API_KEY, 'ws-1');
      expect(svc.resendAccountCode).toHaveBeenCalledWith('ws-1');
      expect(out.status).toBe('code_requested');
    });

    it('get account: forwards', async () => {
      const out = await controller.getAccount(API_KEY, 'ws-1');
      expect(svc.getAccount).toHaveBeenCalledWith('ws-1');
      expect(out.tgUsername).toBe('@x');
    });

    it('delete account: forwards', async () => {
      const out = await controller.deleteAccount(API_KEY, 'ws-1');
      expect(svc.deleteAccount).toHaveBeenCalledWith('ws-1');
      expect(out.status).toBe('unlinked');
    });
  });
});
