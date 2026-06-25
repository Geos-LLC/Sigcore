import {
  Body,
  Controller,
  Delete,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SigcoreAuthGuard } from '../../auth/sigcore-auth.guard';
import { TenantId, WorkspaceId } from '../../auth/decorators/workspace-id.decorator';
import { TelegramPublisherService } from './telegram-publisher.service';
import {
  AccountCodeDto,
  AccountPasswordDto,
  StartAccountLinkDto,
} from './dto/publish-placement.dto';

/**
 * Account-mode endpoints. Mounted under /api/integrations/telegram/account
 * so the existing bot-mode routes on TelegramPublisherController are
 * unchanged. HF calls these in sequence: /start → /code → (/password if
 * 2FA) → linked. The state lives in telegram_subscribers; TelePorter is
 * the source of truth for the session.
 */
@Controller('integrations/telegram/account')
@UseGuards(SigcoreAuthGuard)
export class TelegramAccountController {
  constructor(private readonly service: TelegramPublisherService) {}

  @Post('start')
  async start(
    @WorkspaceId() workspaceId: string,
    @TenantId() tenantId: string | null,
    @Body() body: StartAccountLinkDto,
  ) {
    return this.service.startAccountLink(workspaceId, tenantId || undefined, {
      phoneNumber: body.phoneNumber,
      password: body.password,
      riskAcknowledged: body.riskAcknowledged,
    });
  }

  @Post('code')
  async code(@WorkspaceId() workspaceId: string, @Body() body: AccountCodeDto) {
    return this.service.submitAccountCode(workspaceId, body.code);
  }

  @Post('password')
  async password(
    @WorkspaceId() workspaceId: string,
    @Body() body: AccountPasswordDto,
  ) {
    return this.service.submitAccountPassword(workspaceId, body.password);
  }

  @Post('resend-code')
  async resend(@WorkspaceId() workspaceId: string) {
    return this.service.resendAccountCode(workspaceId);
  }

  @Delete()
  async unlink(@WorkspaceId() workspaceId: string) {
    return this.service.deleteAccount(workspaceId);
  }
}
