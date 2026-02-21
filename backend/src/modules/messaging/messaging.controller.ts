import { Controller, Post, Get, Delete, Body, Param, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { SigcoreAuthGuard } from '../auth/sigcore-auth.guard';
import { WorkspaceId } from '../auth/decorators/workspace-id.decorator';
import { MessagingService } from './messaging.service';
import { SendMessageDto } from './dto/send-message.dto';

/**
 * Internal SMS API consumed by LeadBridge.
 * All routes require an X-API-Key workspace API key.
 */
@Controller('internal/messages')
@UseGuards(SigcoreAuthGuard)
export class MessagingController {
  constructor(private readonly messagingService: MessagingService) {}

  // ──────────────────────────────────────────────────────────────
  // Phone number assignments
  // ──────────────────────────────────────────────────────────────

  /**
   * List all phone number assignments for the workspace.
   * GET /api/internal/messages/assignments
   */
  @Get('assignments')
  async listAssignments(@WorkspaceId() workspaceId: string) {
    return this.messagingService.listAssignments(workspaceId);
  }

  /**
   * Register a bot or dedicated phone number for this workspace.
   * POST /api/internal/messages/assignments
   * Body: { numberE164, type: "BOT"|"DEDICATED", region? }
   */
  @Post('assignments')
  @HttpCode(HttpStatus.OK)
  async upsertAssignment(
    @WorkspaceId() workspaceId: string,
    @Body() dto: { numberE164: string; type: 'BOT' | 'DEDICATED'; region?: string },
  ) {
    return this.messagingService.upsertAssignment(workspaceId, dto);
  }

  /**
   * Remove a phone number assignment.
   * DELETE /api/internal/messages/assignments/:id
   */
  @Delete('assignments/:id')
  @HttpCode(HttpStatus.OK)
  async removeAssignment(@WorkspaceId() workspaceId: string, @Param('id') id: string) {
    return this.messagingService.removeAssignment(workspaceId, id);
  }

  // ──────────────────────────────────────────────────────────────
  // Send SMS
  // ──────────────────────────────────────────────────────────────

  /**
   * Send an outbound SMS to a lead.
   * POST /api/internal/messages/send
   */
  @Post('send')
  @HttpCode(HttpStatus.OK)
  async send(@WorkspaceId() workspaceId: string, @Body() dto: SendMessageDto) {
    return this.messagingService.sendMessage(workspaceId, dto);
  }

  // ──────────────────────────────────────────────────────────────
  // Message history
  // ──────────────────────────────────────────────────────────────

  /**
   * List recent messages for the workspace.
   * GET /api/internal/messages
   */
  @Get()
  async listMessages(@WorkspaceId() workspaceId: string) {
    return this.messagingService.listMessages(workspaceId);
  }
}
