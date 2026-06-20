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
  });

  it('configures axios with base URL + service key header', () => {
    new TeleporterClient();
    expect(mockedAxios.create).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://teleporter.test/api/v1',
        headers: expect.objectContaining({
          'X-TelePorter-Service-Key': 'secret-key',
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
});
