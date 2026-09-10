import { Controller, Get, Query, UseGuards, BadRequestException } from '@nestjs/common';
import { SigcoreAuthGuard } from '../auth/sigcore-auth.guard';
import { CarrierLookupService, CarrierLookupResult } from './carrier-lookup.service';

/**
 * Carrier lookup endpoint. Consumed today by LeadBridge's signup flow
 * (AuthService.register → CarrierLookupService.lookupAndPersistForSignup).
 *
 * Protected by SigcoreAuthGuard, so both auth methods work:
 *   1. x-api-key (LeadBridge's existing tenant-scoped key)
 *   2. X-Sigcore-Key + X-Workspace-Id (service-to-service — future use)
 *
 * The response shape is deliberately raw Twilio data (carrier +
 * lineType) — the caller (LB) owns the integration-slug policy so we
 * don't need to redeploy Sigcore when a new integration goes live.
 */
// Controller path is 'lookups' — the app's global '/api' prefix
// (main.ts setGlobalPrefix) prepends the '/api'. Final route: GET /api/lookups/carrier.
@Controller('lookups')
@UseGuards(SigcoreAuthGuard)
export class CarrierLookupController {
  constructor(private readonly svc: CarrierLookupService) {}

  @Get('carrier')
  async carrier(@Query('number') number?: string): Promise<CarrierLookupResult> {
    if (!number || typeof number !== 'string' || !number.trim()) {
      throw new BadRequestException('Query param `number` (E.164) is required');
    }
    return this.svc.lookup(number.trim());
  }
}
