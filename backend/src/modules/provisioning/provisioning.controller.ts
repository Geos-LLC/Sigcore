import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';

import { SigcoreAuthGuard } from '../auth/sigcore-auth.guard';
import {
  CommunicationIdentityResponse,
  ProvisionCommunicationIdentityDto,
} from './dto/provision-communication-identity.dto';
import { ProvisioningService } from './provisioning.service';

/**
 * Wave-2 Task 6B.2 — Communication Identity provisioning endpoint.
 *
 * The single supported way for a consuming product to obtain communication
 * infrastructure from Sigcore. Sigcore owns everything created here.
 *
 * Auth: reuses `SigcoreAuthGuard`. Products call with either the
 * service-to-service `X-Sigcore-Key` header (Wave-2 pattern) or an
 * external API key — both are gated by the guard. No public/anonymous
 * access. The `X-Workspace-Id` header still applies for the service-key
 * path (guard requires it) but the workspaceId it identifies is unrelated
 * to what the provisioning API creates — the guard uses it purely as an
 * auth token identifier.
 */
@Controller('v1/provisioning')
@UseGuards(SigcoreAuthGuard)
export class ProvisioningController {
  constructor(private readonly provisioningService: ProvisioningService) {}

  @Post('communication-identities')
  @HttpCode(HttpStatus.CREATED)
  async provisionCommunicationIdentity(
    @Body() dto: ProvisionCommunicationIdentityDto,
  ): Promise<{ data: CommunicationIdentityResponse }> {
    const data =
      await this.provisioningService.provisionCommunicationIdentity(dto);
    return { data };
  }
}
