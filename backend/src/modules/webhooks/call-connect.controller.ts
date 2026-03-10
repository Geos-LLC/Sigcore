import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { SigcoreAuthGuard } from '../auth/sigcore-auth.guard';
import { WorkspaceId, TenantId } from '../auth/decorators/workspace-id.decorator';
import { CallConnectService } from './call-connect.service';
import { StartCallConnectDto } from './dto/start-call-connect.dto';
import { CancelCallConnectDto } from './dto/cancel-call-connect.dto';
import { UpsertCallConnectSettingsDto } from './dto/upsert-call-connect-settings.dto';

/**
 * Internal REST API consumed by LeadBridge.
 * All routes require either:
 *   X-Sigcore-Key + X-Workspace-Id  (service-to-service)
 *   x-api-key                        (per-workspace API key)
 */
@Controller('internal/call-connect')
@UseGuards(SigcoreAuthGuard)
export class CallConnectController {
  constructor(private readonly callConnectService: CallConnectService) {}

  // ──────────────────────────────────────────────────────────────
  // Settings
  // ──────────────────────────────────────────────────────────────

  /**
   * Create or update Call Connect settings for the authenticated workspace.
   *
   * POST /api/internal/call-connect/settings
   */
  @Post('settings')
  @HttpCode(HttpStatus.OK)
  async upsertSettings(
    @WorkspaceId() workspaceId: string,
    @Body() dto: UpsertCallConnectSettingsDto,
  ) {
    return this.callConnectService.upsertSettings(workspaceId, dto);
  }

  /**
   * Get current settings for the authenticated workspace.
   * Pass ?businessId=<savedAccountId> to retrieve per-account settings.
   *
   * GET /api/internal/call-connect/settings
   */
  @Get('settings')
  async getSettings(
    @WorkspaceId() workspaceId: string,
    @Query('businessId') businessId?: string,
  ) {
    return this.callConnectService.getSettings(workspaceId, businessId);
  }

  // ──────────────────────────────────────────────────────────────
  // Session lifecycle
  // ──────────────────────────────────────────────────────────────

  /**
   * Trigger an Instant Call Connect session for a new lead.
   * Idempotent: repeated calls with the same businessId+leadId return the existing session.
   *
   * POST /api/internal/call-connect/start
   * Body: StartCallConnectDto
   * Response: { sessionId: string, status: string }
   */
  @Post('start')
  @HttpCode(HttpStatus.OK)
  async start(
    @WorkspaceId() workspaceId: string,
    @TenantId() tenantId: string | undefined,
    @Body() dto: StartCallConnectDto,
  ) {
    return this.callConnectService.startSession(workspaceId, dto, tenantId);
  }

  /**
   * Cancel an active session (hangs up live calls).
   *
   * POST /api/internal/call-connect/cancel
   * Body: { sessionId: string }
   */
  @Post('cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @WorkspaceId() workspaceId: string,
    @Body() dto: CancelCallConnectDto,
  ) {
    await this.callConnectService.cancelSession(workspaceId, dto.sessionId);
    return { canceled: true };
  }

  /**
   * Get the current state of a session.
   *
   * GET /api/internal/call-connect/sessions/:sessionId
   */
  @Get('sessions/:sessionId')
  async getSession(
    @WorkspaceId() workspaceId: string,
    @Param('sessionId') sessionId: string,
  ) {
    return this.callConnectService.getSession(workspaceId, sessionId);
  }
}
