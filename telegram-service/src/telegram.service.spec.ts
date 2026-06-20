import { TelegramService } from './telegram.service';
import { VerifyCache } from './verify-cache.service';

describe('TelegramService', () => {
  let svc: TelegramService;
  let teleporter: { provisionSubscriber: jest.Mock; verifyChat: jest.Mock; publishMessage: jest.Mock; cancelMessage: jest.Mock; getSubscriber: jest.Mock; deleteSubscriber: jest.Mock };
  let cache: VerifyCache;

  beforeEach(() => {
    process.env.TELEGRAM_VERIFY_CACHE_TTL_MS = '60000';
    process.env.TELEGRAM_VERIFY_CACHE_MAX_ENTRIES = '100';
    teleporter = {
      provisionSubscriber: jest.fn(),
      verifyChat: jest.fn(),
      publishMessage: jest.fn(),
      cancelMessage: jest.fn(),
      getSubscriber: jest.fn(),
      deleteSubscriber: jest.fn(),
    };
    cache = new VerifyCache();
    svc = new TelegramService(teleporter as any, cache);
  });

  describe('verifyChat', () => {
    it('caches non-probe results, returns cached on second call', async () => {
      teleporter.verifyChat.mockResolvedValue({ status: 'ready', warnings: [] });
      const first = await svc.verifyChat({ workspaceId: 'ws-1', chatRef: '@foo' });
      const second = await svc.verifyChat({ workspaceId: 'ws-1', chatRef: '@foo' });
      expect(teleporter.verifyChat).toHaveBeenCalledTimes(1);
      expect(first).toEqual(second);
    });

    it('injects PAY_TO_POST_NOT_DETECTABLE warning when status is ready', async () => {
      teleporter.verifyChat.mockResolvedValue({ status: 'ready', warnings: ['EXISTING'] });
      const verdict = await svc.verifyChat({ workspaceId: 'ws-1', chatRef: '@foo' });
      expect(verdict.warnings).toEqual(['EXISTING', 'PAY_TO_POST_NOT_DETECTABLE']);
    });

    it('does NOT inject warning when status is not ready', async () => {
      teleporter.verifyChat.mockResolvedValue({ status: 'blocked', warnings: [] });
      const verdict = await svc.verifyChat({ workspaceId: 'ws-1', chatRef: '@foo' });
      expect(verdict.warnings).toEqual([]);
    });

    it('bypasses cache when probe=true', async () => {
      teleporter.verifyChat.mockResolvedValue({ status: 'ready', warnings: [] });
      await svc.verifyChat({ workspaceId: 'ws-1', chatRef: '@foo' }); // cached
      await svc.verifyChat({ workspaceId: 'ws-1', chatRef: '@foo', probe: true });
      expect(teleporter.verifyChat).toHaveBeenCalledTimes(2);
    });

    it('does not cache probe results', async () => {
      teleporter.verifyChat.mockResolvedValue({ status: 'ready', warnings: [] });
      await svc.verifyChat({ workspaceId: 'ws-1', chatRef: '@foo', probe: true });
      await svc.verifyChat({ workspaceId: 'ws-1', chatRef: '@foo' });
      expect(teleporter.verifyChat).toHaveBeenCalledTimes(2);
    });
  });

  describe('publish', () => {
    it('passes idempotencyKey + callbackUrl to TelePorter', async () => {
      process.env.TELEPORTER_CALLBACK_URL = 'https://svc.test/webhooks/teleporter';
      teleporter.publishMessage.mockResolvedValue({ messageId: 'msg_1', status: 'queued' });
      await svc.publish({
        workspaceId: 'ws-1',
        chatRef: '@foo',
        text: 'hi',
        idempotencyKey: 'k1',
      });
      expect(teleporter.publishMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          subscriberWorkspaceId: 'ws-1',
          idempotencyKey: 'k1',
          callbackUrl: 'https://svc.test/webhooks/teleporter',
        }),
      );
    });
  });
});
