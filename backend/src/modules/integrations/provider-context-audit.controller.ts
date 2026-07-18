import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SigcoreAuthGuard } from '../auth/sigcore-auth.guard';
import {
  ProviderContextAuditReport,
  ProviderContextAuditService,
} from './provider-context-audit.service';

/**
 * Incident 2026-07-18 Wave-3 completion — GET /admin/provider-context/audit.
 *
 * Gated on the same `SigcoreAuthGuard` used by other admin endpoints
 * (workspaces, phone-assignments, businesses). Returns 200 with the
 * four-section audit report described in
 * `ProviderContextAuditService`.
 *
 * Filters (query params):
 *   - workspaceId  optional UUID
 *   - tenantId     optional UUID
 *   - phone        optional E.164 (matches `tenant_phone_numbers.phone_number`)
 *
 * Called by:
 *   - Admin dashboard's Provider Context page
 *   - CI post-deploy check — a zero-count response is the regression
 *     barrier for the ambiguity invariant
 *   - `backend/scripts/audit-provider-context.js` (same shape via CLI)
 */
@Controller('admin/provider-context')
@UseGuards(SigcoreAuthGuard)
export class ProviderContextAuditController {
  constructor(private readonly svc: ProviderContextAuditService) {}

  @Get('audit')
  async audit(
    @Query('workspaceId') workspaceId?: string,
    @Query('tenantId') tenantId?: string,
    @Query('phone') phone?: string,
  ): Promise<{ data: ProviderContextAuditReport }> {
    const data = await this.svc.run({
      workspaceId: workspaceId ?? null,
      tenantId: tenantId ?? null,
      phone: phone ?? null,
    });
    return { data };
  }
}
