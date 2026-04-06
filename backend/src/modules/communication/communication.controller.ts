import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
  Header,
} from '@nestjs/common';
import { CommunicationService } from './communication.service';
import { SendMessageDto, InitiateCallDto } from './dto';
import { SigcoreAuthGuard } from '../auth/sigcore-auth.guard';
import { WorkspaceId } from '../auth/decorators/workspace-id.decorator';
import { RequiresTenantScope } from '../auth/decorators/require-tenant-scope.decorator';

@Controller('contacts/:contactId')
@UseGuards(SigcoreAuthGuard)
// @RequiresTenantScope() // TODO: re-enable after TypeORM tenant_id fix
export class CommunicationController {
  constructor(private readonly communicationService: CommunicationService) {}

  @Get('messages')
  @Header('Cache-Control', 'no-cache, no-store, must-revalidate')
  async getMessages(
    @Param('contactId') contactId: string,
    @WorkspaceId() workspaceId: string,
  ) {
    const messages = await this.communicationService.getMessagesForContact(
      workspaceId,
      contactId,
    );
    return { data: messages };
  }

  @Post('messages')
  @HttpCode(HttpStatus.CREATED)
  async sendMessage(
    @Param('contactId') contactId: string,
    @WorkspaceId() workspaceId: string,
    @Body() dto: SendMessageDto,
  ) {
    const message = await this.communicationService.sendMessage(
      workspaceId,
      contactId,
      dto.body,
      dto.fromNumber,
    );
    return { data: message };
  }

  @Get('calls')
  @Header('Cache-Control', 'no-cache, no-store, must-revalidate')
  async getCalls(
    @Param('contactId') contactId: string,
    @WorkspaceId() workspaceId: string,
  ) {
    const calls = await this.communicationService.getCallsForContact(
      workspaceId,
      contactId,
    );
    return { data: calls };
  }

  @Post('calls/initiate')
  @HttpCode(HttpStatus.OK)
  async initiateCall(
    @Param('contactId') contactId: string,
    @WorkspaceId() workspaceId: string,
    @Body() dto: InitiateCallDto,
  ) {
    const result = await this.communicationService.initiateCall(
      workspaceId,
      contactId,
      dto.fromNumber,
    );
    return { data: result };
  }

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  async syncContactCommunications(
    @Param('contactId') contactId: string,
    @WorkspaceId() workspaceId: string,
  ) {
    const result = await this.communicationService.syncContactCommunications(
      workspaceId,
      contactId,
    );
    return { data: result };
  }
}
