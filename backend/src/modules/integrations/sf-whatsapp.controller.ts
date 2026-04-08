import {
  Controller,
  Get,
  Post,
  Delete,
  UseGuards,
  Res,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { SfAuthGuard } from '../auth/sf-auth.guard';
import { WorkspaceId, TenantId } from '../auth/decorators/workspace-id.decorator';
import { WhatsAppWebProvider } from '../communication/providers/whatsapp-web.provider';

/**
 * SF-facing WhatsApp integration endpoints.
 * Uses SfAuthGuard (JWT) instead of API key auth.
 * All responses follow the same shape as the standard WhatsApp controller.
 */
@Controller('sf/integrations/whatsapp')
@UseGuards(SfAuthGuard)
export class SfWhatsAppController {
  constructor(private readonly whatsappProvider: WhatsAppWebProvider) {}

  @Get('status')
  async getStatus(@WorkspaceId() workspaceId: string) {
    const session = await this.whatsappProvider.getSession(workspaceId);

    if (!session) {
      return {
        data: {
          connected: false,
          status: 'disconnected',
          phoneNumber: null,
          lastSeenAt: null,
          sessionId: workspaceId,
          provider: 'whatsapp',
        },
      };
    }

    return {
      data: {
        connected: session.status === 'ready',
        status: this.mapStatus(session.status),
        phoneNumber: session.phoneNumber || null,
        lastSeenAt: null,
        sessionId: workspaceId,
        provider: 'whatsapp',
      },
    };
  }

  @Post('connect')
  async connect(@WorkspaceId() workspaceId: string) {
    try {
      const session = await this.whatsappProvider.initializeClient(workspaceId);
      return {
        data: {
          success: session.status !== 'error',
          status: this.mapStatus(session.status),
          sessionId: workspaceId,
          provider: 'whatsapp',
        },
      };
    } catch (error) {
      return {
        data: {
          success: false,
          status: 'disconnected',
          error: error instanceof Error ? error.message : 'Failed to connect',
          provider: 'whatsapp',
        },
      };
    }
  }

  @Post('disconnect')
  async disconnect(@WorkspaceId() workspaceId: string) {
    const success = await this.whatsappProvider.disconnect(workspaceId);
    return {
      data: {
        success,
        status: success ? 'disconnected' : 'error',
        provider: 'whatsapp',
      },
    };
  }

  @Get('qr')
  async getQRCode(@WorkspaceId() workspaceId: string, @Res() res: Response) {
    const result = await this.whatsappProvider.getQRCodeResponse(workspaceId);

    if (result.error && result.status === 'error') {
      return res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        data: { error: result.error, status: 'disconnected', provider: 'whatsapp' },
      });
    }

    if (result.connected) {
      return res.status(HttpStatus.OK).json({
        data: {
          connected: true,
          phoneNumber: result.phoneNumber,
          status: 'connected',
          provider: 'whatsapp',
        },
      });
    }

    if (result.qrCode) {
      return res.status(HttpStatus.OK).json({
        data: { qrCode: result.qrCode, status: 'qr_required', provider: 'whatsapp' },
      });
    }

    return res.status(HttpStatus.OK).json({
      data: { status: this.mapStatus(result.status), provider: 'whatsapp' },
    });
  }

  @Get('session')
  async getSessionInfo(@WorkspaceId() workspaceId: string) {
    const session = await this.whatsappProvider.getSession(workspaceId);
    const connected = session?.status === 'ready';

    return {
      data: {
        sessionId: workspaceId,
        connected,
        status: session ? this.mapStatus(session.status) : 'disconnected',
        phoneNumber: session?.phoneNumber || null,
        provider: 'whatsapp',
      },
    };
  }

  private mapStatus(status: string): 'disconnected' | 'qr_required' | 'connecting' | 'connected' {
    switch (status) {
      case 'ready':
        return 'connected';
      case 'qr_ready':
        return 'qr_required';
      case 'initializing':
      case 'authenticated':
        return 'connecting';
      default:
        return 'disconnected';
    }
  }
}
