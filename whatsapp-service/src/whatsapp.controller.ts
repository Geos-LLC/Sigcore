import { Controller, Get, Post, Delete, Body, Param, Headers, HttpException, HttpStatus } from '@nestjs/common';
import { WhatsAppService } from './whatsapp.service';

@Controller()
export class WhatsAppController {
  constructor(private readonly whatsAppService: WhatsAppService) {}

  private validateApiKey(apiKey: string | undefined): void {
    const expectedKey = process.env.SERVICE_API_KEY;
    if (expectedKey && apiKey !== expectedKey) {
      throw new HttpException('Unauthorized', HttpStatus.UNAUTHORIZED);
    }
  }

  @Get('health')
  health() {
    return { status: 'ok', service: 'sigcore-whatsapp' };
  }

  @Get('sessions')
  getSessions(@Headers('x-api-key') apiKey: string) {
    this.validateApiKey(apiKey);
    return { sessions: this.whatsAppService.getConnectedSessions() };
  }

  @Get(':workspaceId/status')
  getStatus(
    @Param('workspaceId') workspaceId: string,
    @Headers('x-api-key') apiKey: string,
  ) {
    this.validateApiKey(apiKey);
    const session = this.whatsAppService.getSession(workspaceId);

    if (!session) {
      return {
        connected: false,
        status: 'not_initialized',
        hasQrCode: false,
        message: 'WhatsApp not initialized for this workspace',
      };
    }

    return {
      connected: session.status === 'ready',
      status: session.status,
      phoneNumber: session.phoneNumber,
      error: session.error,
      hasQrCode: session.status === 'qr_ready' && !!session.qrCodeDataUrl,
      message: this.getStatusMessage(session.status),
    };
  }

  @Post(':workspaceId/connect')
  async connect(
    @Param('workspaceId') workspaceId: string,
    @Headers('x-api-key') apiKey: string,
  ) {
    this.validateApiKey(apiKey);
    try {
      const session = await this.whatsAppService.initializeClient(workspaceId);
      return {
        success: true,
        status: session.status,
        message: this.getStatusMessage(session.status),
      };
    } catch (error) {
      return {
        success: false,
        status: 'error',
        error: error instanceof Error ? error.message : 'Failed to initialize WhatsApp',
      };
    }
  }

  @Get(':workspaceId/qr')
  getQRCode(
    @Param('workspaceId') workspaceId: string,
    @Headers('x-api-key') apiKey: string,
  ) {
    this.validateApiKey(apiKey);
    const session = this.whatsAppService.getSession(workspaceId);

    if (!session) {
      return { error: 'WhatsApp not initialized', status: 'not_initialized' };
    }

    if (session.status === 'ready') {
      return { connected: true, phoneNumber: session.phoneNumber, status: 'ready', message: 'Already connected' };
    }

    if (session.status === 'qr_ready' && session.qrCodeDataUrl) {
      return { qrCode: session.qrCodeDataUrl, status: 'qr_ready' };
    }

    return { status: session.status, message: this.getStatusMessage(session.status) };
  }

  @Post(':workspaceId/send')
  async sendMessage(
    @Param('workspaceId') workspaceId: string,
    @Headers('x-api-key') apiKey: string,
    @Body() body: { to: string; message: string },
  ) {
    this.validateApiKey(apiKey);
    if (!body.to || !body.message) {
      throw new HttpException('Missing required fields: to, message', HttpStatus.BAD_REQUEST);
    }
    return this.whatsAppService.sendMessage(workspaceId, body.to, body.message);
  }

  @Delete(':workspaceId/disconnect')
  async disconnect(
    @Param('workspaceId') workspaceId: string,
    @Headers('x-api-key') apiKey: string,
  ) {
    this.validateApiKey(apiKey);
    const success = await this.whatsAppService.disconnect(workspaceId);
    return { success, message: success ? 'WhatsApp disconnected successfully' : 'Failed to disconnect' };
  }

  private getStatusMessage(status: string): string {
    const messages: Record<string, string> = {
      initializing: 'Initializing WhatsApp client...',
      qr_ready: 'Scan the QR code with your phone',
      authenticated: 'Authenticated, loading chats...',
      ready: 'WhatsApp connected and ready',
      disconnected: 'WhatsApp disconnected',
      error: 'Connection error',
      not_initialized: 'WhatsApp not initialized',
    };
    return messages[status] || status;
  }
}
