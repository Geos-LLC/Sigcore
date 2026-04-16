import { WhatsAppController } from './whatsapp.controller';

// ---------------------------------------------------------------------------
// Mock WhatsAppWebProvider
// ---------------------------------------------------------------------------
function buildProvider() {
  return {
    getSession: jest.fn(),
    initializeClient: jest.fn(),
    getQRCodeResponse: jest.fn(),
    disconnect: jest.fn(),
    isServiceAvailable: jest.fn(),
    isConnected: jest.fn(),
    sendMessage: jest.fn(),
  };
}

function buildTenantIntegrationRepo() {
  return {
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockImplementation(async (e: any) => e),
    create: jest.fn().mockImplementation((data: any) => data),
  };
}

function buildController(provider = buildProvider()) {
  const tenantIntegrationRepo = buildTenantIntegrationRepo();
  const controller = new WhatsAppController(provider as any, tenantIntegrationRepo as any);
  return { controller, provider, tenantIntegrationRepo };
}

function mockRes() {
  const res: any = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res;
}

const WS_ID = 'ws-1';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('WhatsAppController', () => {
  // ===================== Status =====================
  describe('getStatus', () => {
    it('returns not_initialized when no session exists', async () => {
      const { controller, provider } = buildController();
      provider.getSession.mockResolvedValue(null);

      const result = await controller.getStatus(WS_ID);

      expect(result.data.connected).toBe(false);
      expect(result.data.status).toBe('not_initialized');
    });

    it('returns connected=true when session is ready', async () => {
      const { controller, provider } = buildController();
      provider.getSession.mockResolvedValue({
        status: 'ready',
        phoneNumber: '+15551234567',
      });

      const result = await controller.getStatus(WS_ID);

      expect(result.data.connected).toBe(true);
      expect(result.data.status).toBe('ready');
      expect(result.data.phoneNumber).toBe('+15551234567');
    });

    it('returns qr_ready status with hasQrCode=true', async () => {
      const { controller, provider } = buildController();
      provider.getSession.mockResolvedValue({
        status: 'qr_ready',
        phoneNumber: undefined,
      });

      const result = await controller.getStatus(WS_ID);

      expect(result.data.connected).toBe(false);
      expect(result.data.status).toBe('qr_ready');
      expect(result.data.hasQrCode).toBe(true);
    });
  });

  // ===================== Connect =====================
  describe('connect', () => {
    it('returns success when initialization succeeds', async () => {
      const { controller, provider } = buildController();
      provider.initializeClient.mockResolvedValue({ status: 'initializing' });

      const result = await controller.connect(WS_ID, null);

      expect(result.data.success).toBe(true);
      expect(result.data.status).toBe('initializing');
      expect(provider.initializeClient).toHaveBeenCalledWith(WS_ID);
    });

    it('returns error when initialization throws', async () => {
      const { controller, provider } = buildController();
      provider.initializeClient.mockRejectedValue(new Error('Puppeteer crashed'));

      const result = await controller.connect(WS_ID, null);

      expect(result.data.success).toBe(false);
      expect(result.data.status).toBe('error');
      expect(result.data.error).toBe('Puppeteer crashed');
    });

    it('returns success=false when status is error', async () => {
      const { controller, provider } = buildController();
      provider.initializeClient.mockResolvedValue({ status: 'error', error: 'Auth failed' });

      const result = await controller.connect(WS_ID, null);

      expect(result.data.success).toBe(false);
      expect(result.data.error).toBe('Auth failed');
    });
  });

  // ===================== QR Code =====================
  describe('getQRCode', () => {
    it('returns QR code when available', async () => {
      const { controller, provider } = buildController();
      const res = mockRes();
      provider.getQRCodeResponse.mockResolvedValue({
        qrCode: 'data:image/png;base64,abc123',
        status: 'qr_ready',
      });

      await controller.getQRCode(WS_ID, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        data: { qrCode: 'data:image/png;base64,abc123', status: 'qr_ready' },
      });
    });

    it('returns connected info when already connected', async () => {
      const { controller, provider } = buildController();
      const res = mockRes();
      provider.getQRCodeResponse.mockResolvedValue({
        connected: true,
        phoneNumber: '+15551234567',
        status: 'ready',
      });

      await controller.getQRCode(WS_ID, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ connected: true }) }),
      );
    });

    it('returns 503 when service has error', async () => {
      const { controller, provider } = buildController();
      const res = mockRes();
      provider.getQRCodeResponse.mockResolvedValue({
        error: 'Service down',
        status: 'error',
      });

      await controller.getQRCode(WS_ID, res);

      expect(res.status).toHaveBeenCalledWith(503);
    });
  });

  // ===================== Disconnect =====================
  describe('disconnect', () => {
    it('returns success=true on successful disconnect', async () => {
      const { controller, provider } = buildController();
      provider.disconnect.mockResolvedValue(true);

      const result = await controller.disconnect(WS_ID);

      expect(result.data.success).toBe(true);
      expect(provider.disconnect).toHaveBeenCalledWith(WS_ID);
    });

    it('returns success=false on failed disconnect', async () => {
      const { controller, provider } = buildController();
      provider.disconnect.mockResolvedValue(false);

      const result = await controller.disconnect(WS_ID);

      expect(result.data.success).toBe(false);
    });
  });

  // ===================== Health =====================
  describe('checkHealth', () => {
    it('returns available=true when service is running', async () => {
      const { controller, provider } = buildController();
      provider.isServiceAvailable.mockResolvedValue(true);

      const result = await controller.checkHealth();

      expect(result.data.available).toBe(true);
    });

    it('returns available=false when service is down', async () => {
      const { controller, provider } = buildController();
      provider.isServiceAvailable.mockResolvedValue(false);

      const result = await controller.checkHealth();

      expect(result.data.available).toBe(false);
    });
  });

  // ===================== Send Message =====================
  describe('sendMessage', () => {
    it('sends message successfully when connected', async () => {
      const { controller, provider } = buildController();
      const res = mockRes();
      provider.isConnected.mockResolvedValue(true);
      provider.sendMessage.mockResolvedValue({ success: true, messageId: 'wa_123' });

      await controller.sendMessage(WS_ID, { to: '+15559876543', message: 'Hello' }, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        data: { success: true, messageId: 'wa_123' },
      });
      expect(provider.sendMessage).toHaveBeenCalledWith(WS_ID, '+15559876543', 'Hello');
    });

    it('returns 400 when not connected', async () => {
      const { controller, provider } = buildController();
      const res = mockRes();
      provider.isConnected.mockResolvedValue(false);

      await controller.sendMessage(WS_ID, { to: '+15559876543', message: 'Hello' }, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(provider.sendMessage).not.toHaveBeenCalled();
    });

    it('returns 400 when to is missing', async () => {
      const { controller } = buildController();
      const res = mockRes();

      await controller.sendMessage(WS_ID, { to: '', message: 'Hello' }, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 when message is missing', async () => {
      const { controller } = buildController();
      const res = mockRes();

      await controller.sendMessage(WS_ID, { to: '+15559876543', message: '' }, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 400 when send fails', async () => {
      const { controller, provider } = buildController();
      const res = mockRes();
      provider.isConnected.mockResolvedValue(true);
      provider.sendMessage.mockResolvedValue({ success: false, error: 'Number not on WhatsApp' });

      await controller.sendMessage(WS_ID, { to: '+15559876543', message: 'Hello' }, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        data: { success: false, error: 'Number not on WhatsApp' },
      });
    });
  });
});
