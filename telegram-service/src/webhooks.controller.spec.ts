import * as crypto from 'crypto';
import { HttpException, HttpStatus } from '@nestjs/common';
import { WebhooksController } from './webhooks.controller';

describe('WebhooksController', () => {
  const SECRET = 'teleporter-shared-secret';
  let controller: WebhooksController;
  let forwardSpy: jest.Mock;

  beforeEach(() => {
    process.env.TELEPORTER_SERVICE_KEY = SECRET;
    process.env.SIGCORE_WEBHOOK_KEY = 'sigcore-webhook-key';
    forwardSpy = jest.fn().mockResolvedValue(undefined);
    controller = new WebhooksController({ forwardEvent: forwardSpy } as any);
  });

  function signedReq(body: Record<string, unknown>) {
    const raw = Buffer.from(JSON.stringify(body));
    const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
    return { req: { body: raw } as any, sig: `sha256=${sig}`, raw };
  }

  it('forwards valid message.sent → placement.sent', async () => {
    const { req, sig } = signedReq({
      event: 'message.sent',
      subscriberWorkspaceId: 'ws-1',
      messageId: 'msg_1',
      providerMessageId: 'tg_123',
    });
    const result = await controller.handleTeleporterCallback(req, sig);
    expect(result).toEqual({ received: true });
    expect(forwardSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-1',
        eventType: 'placement.sent',
        data: expect.objectContaining({ messageId: 'msg_1', providerMessageId: 'tg_123' }),
      }),
    );
  });

  it('forwards message.failed → placement.failed', async () => {
    const { req, sig } = signedReq({
      event: 'message.failed',
      subscriberWorkspaceId: 'ws-1',
      messageId: 'msg_1',
      errorCode: 'CHAT_NOT_FOUND',
      errorMessage: 'chat not found',
    });
    await controller.handleTeleporterCallback(req, sig);
    expect(forwardSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'placement.failed',
        data: expect.objectContaining({ errorCode: 'CHAT_NOT_FOUND' }),
      }),
    );
  });

  it('rejects invalid signature', async () => {
    const { req } = signedReq({
      event: 'message.sent',
      subscriberWorkspaceId: 'ws-1',
      messageId: 'msg_1',
    });
    await expect(controller.handleTeleporterCallback(req, 'sha256=deadbeef')).rejects.toThrow(
      HttpException,
    );
    expect(forwardSpy).not.toHaveBeenCalled();
  });

  it('rejects missing signature', async () => {
    const { req } = signedReq({ event: 'message.sent', subscriberWorkspaceId: 'ws-1', messageId: 'msg_1' });
    await expect(controller.handleTeleporterCallback(req, undefined as any)).rejects.toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
    });
  });

  it('returns 503 when TELEPORTER_SERVICE_KEY unset', async () => {
    delete process.env.TELEPORTER_SERVICE_KEY;
    const { req, sig } = signedReq({ event: 'message.sent', subscriberWorkspaceId: 'ws-1', messageId: 'msg_1' });
    await expect(controller.handleTeleporterCallback(req, sig)).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
    });
  });

  it('ignores unsupported event types', async () => {
    const { req, sig } = signedReq({
      event: 'message.delivered',
      subscriberWorkspaceId: 'ws-1',
      messageId: 'msg_1',
    });
    const result = await controller.handleTeleporterCallback(req, sig);
    expect(result).toEqual({ received: true, ignored: 'unsupported_event' });
    expect(forwardSpy).not.toHaveBeenCalled();
  });

  it('accepts bare-hex signature (no sha256= prefix)', async () => {
    const body = { event: 'message.sent', subscriberWorkspaceId: 'ws-1', messageId: 'msg_1' };
    const raw = Buffer.from(JSON.stringify(body));
    const sig = crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
    const result = await controller.handleTeleporterCallback({ body: raw } as any, sig);
    expect(result).toEqual({ received: true });
  });
});
