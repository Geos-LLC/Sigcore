import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface WhatsAppSession {
  workspaceId: string;
  status: 'initializing' | 'qr_ready' | 'authenticated' | 'ready' | 'disconnected' | 'error' | 'not_initialized';
  qrCodeDataUrl?: string;
  phoneNumber?: string;
  error?: string;
  message?: string;
}

export interface WhatsAppSendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * WhatsApp Web Provider - HTTP Client
 *
 * This provider communicates with the WhatsApp microservice via HTTP.
 * The actual Puppeteer/Chrome logic runs in a separate service.
 */
@Injectable()
export class WhatsAppWebProvider {
  private readonly logger = new Logger(WhatsAppWebProvider.name);
  private readonly serviceUrl: string;
  private readonly apiKey: string;

  constructor(private configService: ConfigService) {
    this.serviceUrl = this.configService.get<string>('WHATSAPP_SERVICE_URL') || 'http://localhost:3001';
    this.apiKey = this.configService.get<string>('WHATSAPP_SERVICE_API_KEY') || '';
    this.logger.log(`WhatsApp service URL: ${this.serviceUrl}`);
  }

  private async fetch(path: string, options: RequestInit = {}): Promise<any> {
    const url = `${this.serviceUrl}${path}`;

    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          ...options.headers,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`WhatsApp service error: ${response.status} - ${errorText}`);
      }

      return response.json();
    } catch (error) {
      if (error instanceof Error && error.message.includes('fetch failed')) {
        this.logger.warn(`WhatsApp service unavailable at ${this.serviceUrl}`);
        throw new Error('WhatsApp service is not available. Please check if the service is running.');
      }
      throw error;
    }
  }

  /**
   * Initialize a WhatsApp client for a workspace
   */
  async initializeClient(workspaceId: string): Promise<WhatsAppSession> {
    this.logger.log(`Requesting WhatsApp client initialization for workspace ${workspaceId}`);

    try {
      const result = await this.fetch(`/${workspaceId}/connect`, {
        method: 'POST',
      });

      return {
        workspaceId,
        status: result.status,
        error: result.error,
        message: result.message,
      };
    } catch (error) {
      this.logger.error(`Failed to initialize WhatsApp client for workspace ${workspaceId}`, error);
      return {
        workspaceId,
        status: 'error',
        error: error instanceof Error ? error.message : 'Failed to connect to WhatsApp service',
      };
    }
  }

  /**
   * Get session status for a workspace
   */
  async getSession(workspaceId: string): Promise<WhatsAppSession | null> {
    try {
      const result = await this.fetch(`/${workspaceId}/status`);

      return {
        workspaceId,
        status: result.status,
        phoneNumber: result.phoneNumber,
        error: result.error,
        message: result.message,
      };
    } catch (error) {
      this.logger.warn(`Failed to get WhatsApp session for workspace ${workspaceId}`, error);
      return null;
    }
  }

  /**
   * Check if a workspace has an active WhatsApp session
   */
  async isConnected(workspaceId: string): Promise<boolean> {
    try {
      const result = await this.fetch(`/${workspaceId}/status`);
      return result.connected === true;
    } catch {
      return false;
    }
  }

  /**
   * Get QR code for a workspace (returns null if not in qr_ready state)
   */
  async getQRCode(workspaceId: string): Promise<string | null> {
    try {
      const result = await this.fetch(`/${workspaceId}/qr`);
      return result.qrCode || null;
    } catch {
      return null;
    }
  }

  /**
   * Get full QR response including status
   */
  async getQRCodeResponse(workspaceId: string): Promise<{
    qrCode?: string;
    status: string;
    connected?: boolean;
    phoneNumber?: string;
    message?: string;
    error?: string;
  }> {
    try {
      return await this.fetch(`/${workspaceId}/qr`);
    } catch (error) {
      return {
        status: 'error',
        error: error instanceof Error ? error.message : 'Failed to get QR code',
      };
    }
  }

  /**
   * Send a WhatsApp message
   */
  async sendMessage(
    workspaceId: string,
    to: string,
    body: string,
  ): Promise<WhatsAppSendResult> {
    try {
      const result = await this.fetch(`/${workspaceId}/send`, {
        method: 'POST',
        body: JSON.stringify({ to, message: body }),
      });

      return {
        success: result.success,
        messageId: result.messageId,
        error: result.error,
      };
    } catch (error) {
      this.logger.error(`Failed to send WhatsApp message for workspace ${workspaceId}`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to send message',
      };
    }
  }

  /**
   * Disconnect and logout WhatsApp for a workspace
   */
  async disconnect(workspaceId: string): Promise<boolean> {
    try {
      const result = await this.fetch(`/${workspaceId}/disconnect`, {
        method: 'DELETE',
      });
      return result.success;
    } catch (error) {
      this.logger.error(`Failed to disconnect WhatsApp for workspace ${workspaceId}`, error);
      return false;
    }
  }

  /**
   * Get all connected sessions info
   */
  async getConnectedSessions(): Promise<Array<{ workspaceId: string; phoneNumber?: string; status: string }>> {
    try {
      const result = await this.fetch('/sessions');
      return result.sessions || [];
    } catch {
      return [];
    }
  }

  /**
   * Check if WhatsApp service is available
   */
  /**
   * Fetch all individual chats with recent messages (aggregated batch).
   * Used for backfill/sync — one call returns all data.
   */
  async getChatsWithMessages(
    workspaceId: string,
    messageLimit: number = 50,
  ): Promise<{ chats: any[] }> {
    try {
      const result = await this.fetch(
        `/${workspaceId}/chats?includeMessages=true&messageLimit=${messageLimit}`,
      );
      return { chats: result.chats || [] };
    } catch (error) {
      this.logger.error(`Failed to fetch WhatsApp chats for workspace ${workspaceId}`, error);
      return { chats: [] };
    }
  }

  async downloadMedia(
    workspaceId: string,
    chatId: string,
    messageId: string,
  ): Promise<{ data: string; mimetype: string; filename?: string } | null> {
    try {
      const result = await this.fetch(`/${workspaceId}/download-media`, {
        method: 'POST',
        body: JSON.stringify({ messageId, chatId }),
      });
      return result;
    } catch {
      return null;
    }
  }

  async isServiceAvailable(): Promise<boolean> {
    try {
      const result = await this.fetch('/health');
      return result.status === 'ok';
    } catch {
      return false;
    }
  }
}
