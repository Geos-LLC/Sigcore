/**
 * Wave-2 Task 6B.5A — scenarios 1, 8, 12 covered from the integrations.
 *
 *   1. New identity begins pending_credentials (provisioning.service side)
 *   8. Legacy row with valid credentials reports ready via ensure
 *  12. ensureIntegration remains backward compatible — the response shape
 *      still contains id/created/workspaceId/tenantId/provider and adds
 *      operationalStatus + operationalReason without removing anything.
 *
 * Uses source-string invariants rather than a full service compile so it
 * runs in isolation from the DB.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const SRC_ROOT = path.resolve(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(path.join(SRC_ROOT, rel), 'utf8');
}

describe('EnsureIntegration + provisioning — operational readiness contract', () => {
  it('scenario 1: provisioning.service explicitly sets operationalStatus=pending_credentials on new integration rows', () => {
    const src = read('modules/provisioning/provisioning.service.ts');
    // Look for the assignment inside the create() call.
    expect(src).toMatch(/operationalStatus:\s*OperationalStatus\.PENDING_CREDENTIALS/);
    expect(src).toMatch(
      /operationalReason:[\s\n]*OperationalReasonCode\.TWILIO_CREDENTIALS_NOT_CONFIGURED/,
    );
  });

  it('scenario 8: NULL operationalStatus is mapped to `ready` for grandfathered rows in ensure response', () => {
    const src = read('modules/integrations/integrations.service.ts');
    // The helper `toEnsureResult` does the NULL → ready mapping.
    expect(src).toMatch(/operationalStatus:\s*row\.operationalStatus\s*\?\?\s*OperationalStatus\.READY/);
    // And ensureIntegration returns via that helper on every code path.
    const returns = (src.match(/return\s+toEnsureResult\(/g) ?? []).length;
    expect(returns).toBeGreaterThanOrEqual(3);
  });

  it('scenario 12: EnsureIntegrationResult includes pre-6B.5A fields (backward compat) + adds operational fields', () => {
    const dto = read('modules/integrations/dto/ensure-integration.dto.ts');
    // Pre-6B.5A fields — must all still be present.
    for (const field of ['id', 'created', 'workspaceId', 'tenantId', 'provider']) {
      expect(dto).toMatch(new RegExp(`\\b${field}:\\s*`));
    }
    // New fields.
    expect(dto).toMatch(/operationalStatus:\s*string/);
    expect(dto).toMatch(/operationalReason:\s*string\s*\|\s*null/);
  });

  it('scenario 12b: provisioning response DTO extends ProvisionedIntegration with operationalStatus + operationalReason', () => {
    const dto = read('modules/provisioning/dto/provision-communication-identity.dto.ts');
    expect(dto).toMatch(/interface\s+ProvisionedIntegration/);
    expect(dto).toMatch(/operationalStatus:\s*string/);
    expect(dto).toMatch(/operationalReason:\s*string\s*\|\s*null/);
    // Pre-6B.5A fields preserved.
    expect(dto).toMatch(/provider:\s*string/);
    expect(dto).toMatch(/integrationId:\s*string/);
    expect(dto).toMatch(/\bstatus:\s*string/);
  });
});
