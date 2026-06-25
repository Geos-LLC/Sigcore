import {
  BadRequestException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { TelegramEventCallbackController } from './telegram-event-callback.controller';

describe('TelegramEventCallbackController', () => {
  let controller: TelegramEventCallbackController;
  let service: { handleProviderEvent: jest.Mock };

  beforeEach(() => {
    process.env.SIGCORE_WEBHOOK_KEY = 'shared-secret';
    service = { handleProviderEvent: jest.fn().mockResolvedValue(undefined) };
    controller = new TelegramEventCallbackController(service as any);
  });

  const validBody = {
    workspaceId: 'ws-1',
    eventType: 'placement.sent' as const,
    timestamp: '2026-06-19T00:00:00Z',
    data: { messageId: 'tp_msg_1' },
  };

  it('503s when SIGCORE_WEBHOOK_KEY unset', async () => {
    delete process.env.SIGCORE_WEBHOOK_KEY;
    await expect(controller.handleEvent('any', validBody)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('401s on bad webhook key', async () => {
    await expect(controller.handleEvent('wrong-key', validBody)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(service.handleProviderEvent).not.toHaveBeenCalled();
  });

  it('400s on missing fields', async () => {
    await expect(
      controller.handleEvent('shared-secret', { eventType: 'placement.sent' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('400s on unsupported eventType', async () => {
    await expect(
      controller.handleEvent('shared-secret', {
        ...validBody,
        eventType: 'placement.queued' as any,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('forwards valid event to service', async () => {
    const result = await controller.handleEvent('shared-secret', validBody);
    expect(result).toEqual({ received: true });
    expect(service.handleProviderEvent).toHaveBeenCalledWith(validBody);
  });

  it.each(['account.linked', 'account.revoked'])(
    'accepts new account event %s',
    async (eventType) => {
      const body = { ...validBody, eventType: eventType as any, data: { accountId: 'a' } };
      const result = await controller.handleEvent('shared-secret', body);
      expect(result).toEqual({ received: true });
      expect(service.handleProviderEvent).toHaveBeenCalledWith(body);
    },
  );
});
