import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  UseGuards,
  Res,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { SigcoreAuthGuard } from '../auth/sigcore-auth.guard';
import { WorkspaceId } from '../auth/decorators/workspace-id.decorator';
import { WhatsAppWebProvider } from '../communication/providers/whatsapp-web.provider';

@Controller('integrations/whatsapp')
@UseGuards(SigcoreAuthGuard)
export class WhatsAppController {
  constructor(private readonly whatsappProvider: WhatsAppWebProvider) {}

  /**
   * Get WhatsApp connection status for the workspace
   */
  @Get('status')
  async getStatus(@WorkspaceId() workspaceId: string) {
    const session = await this.whatsappProvider.getSession(workspaceId);

    if (!session) {
      return {
        data: {
          connected: false,
          status: 'not_initialized',
          hasQrCode: false,
          message: 'WhatsApp not connected. Click "Connect" to start.',
        },
      };
    }

    return {
      data: {
        connected: session.status === 'ready',
        status: session.status,
        phoneNumber: session.phoneNumber,
        error: session.error,
        hasQrCode: session.status === 'qr_ready',
        message: session.message || this.getStatusMessage(session.status),
      },
    };
  }

  private getStatusMessage(status: string): string {
    switch (status) {
      case 'initializing':
        return 'Initializing WhatsApp connection...';
      case 'qr_ready':
        return 'Scan the QR code with your WhatsApp app';
      case 'authenticated':
        return 'Authenticated, loading chats...';
      case 'ready':
        return 'WhatsApp connected and ready';
      case 'disconnected':
        return 'WhatsApp disconnected';
      case 'error':
        return 'Connection error occurred';
      case 'not_initialized':
        return 'WhatsApp not initialized';
      default:
        return 'Unknown status';
    }
  }

  /**
   * Start WhatsApp connection (generates QR code)
   */
  @Post('connect')
  async connect(@WorkspaceId() workspaceId: string) {
    try {
      const session = await this.whatsappProvider.initializeClient(workspaceId);

      return {
        data: {
          success: session.status !== 'error',
          status: session.status,
          message: session.message || 'WhatsApp connection initiated. Please wait for QR code...',
          error: session.error,
        },
      };
    } catch (error) {
      return {
        data: {
          success: false,
          status: 'error',
          error: error instanceof Error ? error.message : 'Failed to connect',
        },
      };
    }
  }

  /**
   * Get QR code for scanning
   */
  @Get('qr')
  async getQRCode(@WorkspaceId() workspaceId: string, @Res() res: Response) {
    const result = await this.whatsappProvider.getQRCodeResponse(workspaceId);

    if (result.error && result.status === 'error') {
      return res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        data: { error: result.error, status: 'error' },
      });
    }

    if (result.connected) {
      return res.status(HttpStatus.OK).json({
        data: {
          connected: true,
          phoneNumber: result.phoneNumber,
          status: result.status,
          message: result.message || 'Already connected',
        },
      });
    }

    if (result.qrCode) {
      return res.status(HttpStatus.OK).json({
        data: { qrCode: result.qrCode, status: result.status },
      });
    }

    return res.status(HttpStatus.OK).json({
      data: { status: result.status, message: result.message, error: result.error },
    });
  }

  /**
   * Disconnect WhatsApp
   */
  @Delete('disconnect')
  async disconnect(@WorkspaceId() workspaceId: string) {
    const success = await this.whatsappProvider.disconnect(workspaceId);

    return {
      data: {
        success,
        message: success ? 'WhatsApp disconnected successfully' : 'Failed to disconnect',
      },
    };
  }

  /**
   * Check if WhatsApp service is available
   */
  @Get('health')
  async checkHealth() {
    const available = await this.whatsappProvider.isServiceAvailable();

    return {
      data: {
        available,
        message: available ? 'WhatsApp service is running' : 'WhatsApp service is not available',
      },
    };
  }

  /**
   * Send a WhatsApp message directly via the WhatsApp service.
   */
  @Post('send')
  async sendMessage(
    @WorkspaceId() workspaceId: string,
    @Body() body: { to: string; message: string },
    @Res() res: Response,
  ) {
    if (!body.to || !body.message) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        data: { error: 'Missing required fields: to, message' },
      });
    }

    const connected = await this.whatsappProvider.isConnected(workspaceId);
    if (!connected) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        data: { error: 'WhatsApp not connected. Connect first and scan the QR code.' },
      });
    }

    const result = await this.whatsappProvider.sendMessage(workspaceId, body.to, body.message);
    return res.status(result.success ? HttpStatus.OK : HttpStatus.BAD_REQUEST).json({
      data: result,
    });
  }
}
