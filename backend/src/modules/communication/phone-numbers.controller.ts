import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { PhoneNumbersService } from './phone-numbers.service';
import { CommunicationService } from './communication.service';
import {
  ProvisionPhoneNumberDto,
  AssignPhoneNumberDto,
  ReleasePhoneNumberDto,
  ListPhoneNumbersQueryDto,
} from './dto/phone-number.dto';
import { WebhookConfigDto } from './dto/webhook-config.dto';
import { SigcoreAuthGuard } from '../auth/sigcore-auth.guard';
import { WorkspaceId } from '../auth/decorators/workspace-id.decorator';
import { UseIntegrationResourceGuard } from '../../common/guards/use-integration-resource-guard.decorator';

/**
 * Phone Number Management API
 *
 * Endpoints for managing phone numbers
 */
@Controller('phone-numbers')
@UseGuards(SigcoreAuthGuard)
export class PhoneNumbersController {
  constructor(private readonly phoneNumbersService: PhoneNumbersService) {}

  /**
   * List phone numbers for the workspace
   *
   * @example GET /api/phone-numbers?mode=shared&assigned=true
   */
  @Get()
  async listPhoneNumbers(
    @WorkspaceId() workspaceId: string,
    @Query() query: ListPhoneNumbersQueryDto,
  ) {
    const phoneNumbers = await this.phoneNumbersService.listPhoneNumbers(workspaceId, query);
    return { data: phoneNumbers };
  }

  /**
   * Search for available phone numbers (without purchasing)
   *
   * @example GET /api/phone-numbers/available?country=US&areaCode=813
   */
  @Get('available')
  async searchAvailableNumbers(
    @WorkspaceId() workspaceId: string,
    @Query('country') country: string,
    @Query('areaCode') areaCode?: string,
  ) {
    const numbers = await this.phoneNumbersService.searchAvailableNumbers(
      workspaceId,
      country || 'US',
      areaCode,
    );
    return { data: numbers };
  }

  /**
   * Provision a new phone number from Twilio
   *
   * @example POST /api/phone-numbers/provision
   * {
   *   "country": "US",
   *   "areaCode": "813",
   *   "mode": "dedicated",
   *   "name": "LeadBridge Notifications"
   * }
   */
  @Post('provision')
  @HttpCode(HttpStatus.CREATED)
  async provisionPhoneNumber(
    @WorkspaceId() workspaceId: string,
    @Body() dto: ProvisionPhoneNumberDto,
  ) {
    const phoneNumber = await this.phoneNumbersService.provisionPhoneNumber(workspaceId, dto);
    return { data: phoneNumber };
  }

  /**
   * Assign a phone number to a specific mode
   *
   * @example POST /api/phone-numbers/assign
   * {
   *   "senderId": "uuid",
   *   "mode": "dedicated",
   *   "name": "LeadBridge Notifications"
   * }
   */
  @Post('assign')
  async assignPhoneNumber(
    @WorkspaceId() workspaceId: string,
    @Body() dto: AssignPhoneNumberDto,
  ) {
    const phoneNumber = await this.phoneNumbersService.assignPhoneNumber(workspaceId, dto);
    return { data: phoneNumber };
  }

  /**
   * Release a phone number
   *
   * @example POST /api/phone-numbers/release
   * {
   *   "senderId": "uuid",
   *   "reason": "No longer needed"
   * }
   */
  @Post('release')
  async releasePhoneNumber(
    @WorkspaceId() workspaceId: string,
    @Body() dto: ReleasePhoneNumberDto,
  ) {
    const result = await this.phoneNumbersService.releasePhoneNumber(workspaceId, dto);
    return { data: result };
  }
}

/**
 * Phone Numbers API for external systems (API Key auth)
 */
@Controller('v1/phone-numbers')
@UseGuards(SigcoreAuthGuard)
export class PhoneNumbersV1Controller {
  constructor(
    private readonly phoneNumbersService: PhoneNumbersService,
    private readonly communicationService: CommunicationService,
  ) {}

  /**
   * List all phone numbers from connected integrations (OpenPhone + Twilio)
   * Returns phone numbers directly from provider APIs
   */
  @Get()
  async listPhoneNumbers(@WorkspaceId() workspaceId: string) {
    // Fetch phone numbers from all connected integrations (OpenPhone + Twilio)
    const phoneNumbers = await this.communicationService.getPhoneNumbers(workspaceId);
    return { data: phoneNumbers };
  }

  @Post('provision')
  @HttpCode(HttpStatus.CREATED)
  async provisionPhoneNumber(
    @WorkspaceId() workspaceId: string,
    @Body() dto: ProvisionPhoneNumberDto,
  ) {
    const phoneNumber = await this.phoneNumbersService.provisionPhoneNumber(workspaceId, dto);
    return { data: phoneNumber };
  }

  @Post('assign')
  async assignPhoneNumber(
    @WorkspaceId() workspaceId: string,
    @Body() dto: AssignPhoneNumberDto,
  ) {
    const phoneNumber = await this.phoneNumbersService.assignPhoneNumber(workspaceId, dto);
    return { data: phoneNumber };
  }

  @Post('release')
  async releasePhoneNumber(
    @WorkspaceId() workspaceId: string,
    @Body() dto: ReleasePhoneNumberDto,
  ) {
    const result = await this.phoneNumbersService.releasePhoneNumber(workspaceId, dto);
    return { data: result };
  }
}

/**
 * Wave-2 Task 4 — webhook-config endpoint.
 *
 * Split into its own controller so we can stack SigcoreAuthGuard +
 * @UseIntegrationResourceGuard('tpnId') without disturbing the existing
 * v1/phone-numbers routes (list / provision / assign / release) which use a
 * different auth expectation (no per-route resource guard, no integrationId
 * body requirement).
 *
 * Route:
 *   POST /v1/phone-numbers/:tpnId/webhook-config
 */
@Controller('v1/phone-numbers')
@UseGuards(SigcoreAuthGuard)
export class PhoneNumbersWebhookConfigController {
  constructor(private readonly phoneNumbersService: PhoneNumbersService) {}

  @Post(':tpnId/webhook-config')
  @HttpCode(HttpStatus.OK)
  @UseIntegrationResourceGuard('tpnId')
  async configureWebhooks(
    @Param('tpnId') tpnId: string,
    @Body() dto: WebhookConfigDto,
  ) {
    const result = await this.phoneNumbersService.configureWebhooks(tpnId, dto);
    return { data: result };
  }
}
