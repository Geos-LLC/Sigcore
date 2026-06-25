import axios from 'axios';
import { TeleporterClient } from './teleporter-client.service';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('TeleporterClient', () => {
  let mockInstance: { request: jest.Mock };

  beforeEach(() => {
    mockInstance = { request: jest.fn() };
    (mockedAxios.create as jest.Mock).mockReturnValue(mockInstance);
    process.env.TELEPORTER_BASE_URL = 'https://teleporter.test/api/v1';
    process.env.TELEPORTER_SERVICE_KEY = 'secret-key';
    process.env.TELEPORTER_INTEGRATOR_ID = 'sigcore-hirefunnel';
  });

  it('configures axios with base URL + service key + integrator id headers', () => {
    new TeleporterClient();
    expect(mockedAxios.create).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://teleporter.test/api/v1',
        headers: expect.objectContaining({
          'X-TelePorter-Service-Key': 'secret-key',
          'X-TelePorter-Integrator-Id': 'sigcore-hirefunnel',
        }),
      }),
    );
  });

  it('provisionSubscriber POSTs to /subscribers', async () => {
    mockInstance.request.mockResolvedValue({
      data: { subscriberId: 'sub_1', botUsername: 'sigcore_hf_bot', status: 'ready' },
    });
    const client = new TeleporterClient();
    const result = await client.provisionSubscriber({ subscriberWorkspaceId: 'ws-1' });
    expect(mockInstance.request).toHaveBeenCalledWith({
      method: 'POST',
      url: '/subscribers',
      data: { subscriberWorkspaceId: 'ws-1' },
    });
    expect(result.botUsername).toBe('sigcore_hf_bot');
  });

  it('publishMessage POSTs to /messages', async () => {
    mockInstance.request.mockResolvedValue({
      data: { messageId: 'msg_1', status: 'queued' },
    });
    const client = new TeleporterClient();
    const result = await client.publishMessage({
      subscriberWorkspaceId: 'ws-1',
      chatRef: '@foo',
      text: 'hi',
      idempotencyKey: 'k1',
      callbackUrl: 'http://localhost/webhooks/teleporter',
    });
    expect(mockInstance.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST', url: '/messages' }),
    );
    expect(result.messageId).toBe('msg_1');
  });

  it('cancelMessage POSTs to /messages/:id/cancel', async () => {
    mockInstance.request.mockResolvedValue({ data: { messageId: 'msg_1', status: 'cancelled' } });
    const client = new TeleporterClient();
    const result = await client.cancelMessage('msg_1');
    expect(mockInstance.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST', url: '/messages/msg_1/cancel' }),
    );
    expect(result.status).toBe('cancelled');
  });

  it('throws HttpException with upstream status on 4xx', async () => {
    mockInstance.request.mockRejectedValue({
      response: { status: 404, data: { message: 'Not found' } },
      message: 'Request failed with status code 404',
    });
    const client = new TeleporterClient();
    await expect(client.getSubscriber('missing-ws')).rejects.toMatchObject({
      status: 404,
    });
  });

  describe('account-mode methods', () => {
    it('startAccountLink POSTs /accounts with body', async () => {
      mockInstance.request.mockResolvedValue({ data: { accountId: 'acc_1', status: 'code_requested' } });
      const client = new TeleporterClient();
      await client.startAccountLink({ subscriberWorkspaceId: 'ws-1', phoneNumber: '+1', riskAcknowledged: true });
      expect(mockInstance.request).toHaveBeenCalledWith({
        method: 'POST', url: '/accounts',
        data: { subscriberWorkspaceId: 'ws-1', phoneNumber: '+1', riskAcknowledged: true },
      });
    });

    it('submitAccountCode POSTs /accounts/:ws/code', async () => {
      mockInstance.request.mockResolvedValue({ data: { accountId: 'acc_1', status: 'linked' } });
      const client = new TeleporterClient();
      await client.submitAccountCode('ws-1', '12345');
      expect(mockInstance.request).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'POST', url: '/accounts/ws-1/code', data: { code: '12345' } }),
      );
    });

    it('submitAccountPassword POSTs /accounts/:ws/password', async () => {
      mockInstance.request.mockResolvedValue({ data: { accountId: 'acc_1', status: 'linked' } });
      const client = new TeleporterClient();
      await client.submitAccountPassword('ws-1', 's3cret');
      expect(mockInstance.request).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'POST', url: '/accounts/ws-1/password', data: { password: 's3cret' } }),
      );
    });

    it('resendAccountCode POSTs /accounts/:ws/resend-code', async () => {
      mockInstance.request.mockResolvedValue({ data: { status: 'code_requested' } });
      const client = new TeleporterClient();
      await client.resendAccountCode('ws-1');
      expect(mockInstance.request).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'POST', url: '/accounts/ws-1/resend-code' }),
      );
    });

    it('getAccount GETs /accounts/:ws', async () => {
      mockInstance.request.mockResolvedValue({ data: { accountId: 'acc_1', status: 'linked' } });
      const client = new TeleporterClient();
      await client.getAccount('ws-1');
      expect(mockInstance.request).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'GET', url: '/accounts/ws-1' }),
      );
    });

    it('deleteAccount DELETEs /accounts/:ws', async () => {
      mockInstance.request.mockResolvedValue({ data: { status: 'unlinked' } });
      const client = new TeleporterClient();
      await client.deleteAccount('ws-1');
      expect(mockInstance.request).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'DELETE', url: '/accounts/ws-1' }),
      );
    });
  });

  it('preserves full upstream response body on the exception (round-2 logging fix)', async () => {
    // TelePorter's error body isn't `{message: ...}` shaped — covered:
    // `error`, `details`, plain string, and nothing at all.
    const cases: Array<{ data: any; expectMsg: string }> = [
      { data: { error: 'invalid_workspace_format' }, expectMsg: 'invalid_workspace_format' },
      { data: { details: 'displayName required' }, expectMsg: 'displayName required' },
      { data: 'plain text error', expectMsg: 'plain text error' },
    ];
    for (const c of cases) {
      mockInstance.request.mockRejectedValueOnce({
        response: { status: 400, data: c.data },
        message: 'Request failed with status code 400',
      });
      const client = new TeleporterClient();
      const err = await client.getSubscriber('x').catch((e) => e);
      expect(err.status).toBe(400);
      // HttpException stores the body in `.response` (NestJS convention).
      const payload = err.getResponse();
      expect(payload.upstreamStatus).toBe(400);
      expect(payload.upstreamBody).toEqual(c.data);
      expect(payload.message).toEqual(c.expectMsg);
    }
  });
});
