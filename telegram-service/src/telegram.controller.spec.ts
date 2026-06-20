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
});
