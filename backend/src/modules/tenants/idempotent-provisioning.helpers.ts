/**
 * Pure helpers for idempotent tenant provisioning (PR10).
 *
 * Centralizes the input validation + canonical-pick logic that would otherwise
 * be tangled into the controller. Pure — no I/O, no DB. The service module
 * (tenants.service.ts) calls these helpers and owns the actual repo reads/writes.
 *
 * Contract: provisioning the same external id twice MUST return the same
 * tenant id. Anchor tenants must NEVER be reusable as customer tenants.
 * Inactive tenants must not be reused unless the caller explicitly opts in.
 */

// ---------------------------------------------------------------------------
// Anchor detection (mirrors backend/src/modules/admin-views/platform-attribution.ts
// and source-classifier.ts; kept here so the provisioning path doesn't import
// admin-views and the rule stays test-frozen).
// ---------------------------------------------------------------------------

const ANCHOR_NAME_NORMALIZED = new Set([
  'leadbridge',
  'service flow',
  'serviceflow',
  'callio',
  'hirefunnel',
]);

const ANCHOR_EXTERNAL_ID_PATTERN =
  /^(leadbridge|hirefunnel|serviceflow|callio)[-_]/i;

function normalize(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Identifies a provision input that would synthesize an anchor tenant. Used
 * to fail-fast: callers must NEVER provision a customer tenant with anchor
 * name/external_id, even by accident (e.g. an automated test that passes
 * `displayName: "LeadBridge"`).
 */
export function isAnchorProvisionInput(input: {
  externalTenantId: string;
  displayName?: string | null;
}): boolean {
  if (ANCHOR_NAME_NORMALIZED.has(normalize(input.displayName))) return true;
  if (ANCHOR_EXTERNAL_ID_PATTERN.test(input.externalTenantId)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

export interface ProvisionInput {
  externalTenantId: string;
  displayName?: string | null;
  /** Reuse a soft-disabled tenant. Default false (inactive tenants are NOT reused). */
  allowInactive?: boolean;
  /**
   * If false (default), do not return a fresh API key secret when a reusable
   * active tenant key already exists; return a summary instead.
   * If true, mint a brand-new key and return its secret.
   *
   * Existing LB callers should pass forceNewKey: true until they're updated
   * to handle summary-only responses (PR16 adoption).
   */
  forceNewKey?: boolean;
}

export type ValidationFailure =
  | 'missing_external_tenant_id'
  | 'anchor_input_rejected';

export interface ValidatedInput {
  externalTenantId: string;
  displayName: string;
  allowInactive: boolean;
  forceNewKey: boolean;
}

export function validateProvisionInput(
  raw: ProvisionInput,
): { ok: true; value: ValidatedInput } | { ok: false; error: ValidationFailure; detail: string } {
  const externalTenantId = (raw.externalTenantId ?? '').trim();
  if (!externalTenantId) {
    return {
      ok: false,
      error: 'missing_external_tenant_id',
      detail: 'externalTenantId is required',
    };
  }
  if (
    isAnchorProvisionInput({
      externalTenantId,
      displayName: raw.displayName,
    })
  ) {
    return {
      ok: false,
      error: 'anchor_input_rejected',
      detail:
        'Refusing to provision a customer tenant with an anchor name/external_id ' +
        '(LeadBridge, HireFunnel, ServiceFlow, Callio). Anchor tenants are platform handles, not customers.',
    };
  }
  return {
    ok: true,
    value: {
      externalTenantId,
      displayName: (raw.displayName ?? '').trim() || externalTenantId,
      allowInactive: raw.allowInactive === true,
      forceNewKey: raw.forceNewKey === true,
    },
  };
}

// ---------------------------------------------------------------------------
// Existing-tenant selection
// ---------------------------------------------------------------------------

/**
 * Minimal tenant shape this helper needs. Service passes plain rows.
 */
export interface CandidateTenant {
  id: string;
  status: string;
  /** True if the tenant.name matches an anchor — defensive double-check. */
  name?: string | null;
}

export interface SelectExistingDecision {
  decision: 'reuse' | 'create_new' | 'reject';
  tenantId?: string;
  reason: string;
}

/**
 * Given the candidate(s) found for the (workspaceId, externalTenantId) lookup,
 * decide whether to reuse one, create a new one, or reject.
 *
 * Rules in order:
 *   - Empty list                                      → create_new
 *   - Any candidate is an anchor                      → reject (defensive — should never happen post-validateProvisionInput)
 *   - First active candidate found                    → reuse
 *   - Inactive candidates only AND allowInactive      → reuse the most-recently-touched inactive
 *   - Inactive candidates only AND NOT allowInactive  → reject (caller can pass allowInactive=true to recover)
 */
export function selectExistingTenant(
  candidates: CandidateTenant[],
  options: { allowInactive: boolean },
): SelectExistingDecision {
  if (candidates.length === 0) {
    return { decision: 'create_new', reason: 'no existing tenant for external_id' };
  }

  // Defensive — anchor names must not be selected even if a name-collision happens.
  const anchorMatch = candidates.find((c) =>
    ANCHOR_NAME_NORMALIZED.has(normalize(c.name)),
  );
  if (anchorMatch) {
    return {
      decision: 'reject',
      reason: `existing tenant ${anchorMatch.id} is an anchor — refusing to reuse as customer tenant`,
    };
  }

  const active = candidates.filter((c) => c.status === 'active');
  if (active.length > 0) {
    // Lowest id deterministically when multiple actives exist (shouldn't happen
    // under the unique index, but guards against race-related dupes).
    const winner = active.slice().sort((a, b) => a.id.localeCompare(b.id))[0];
    return {
      decision: 'reuse',
      tenantId: winner.id,
      reason: 'reusing existing active tenant',
    };
  }

  if (options.allowInactive) {
    const winner = candidates.slice().sort((a, b) => a.id.localeCompare(b.id))[0];
    return {
      decision: 'reuse',
      tenantId: winner.id,
      reason: 'reusing inactive tenant (allowInactive=true)',
    };
  }

  return {
    decision: 'reject',
    reason:
      'existing tenant with this external_id is inactive; pass allowInactive=true to reuse, or use a different external_id',
  };
}

// ---------------------------------------------------------------------------
// API key summary
// ---------------------------------------------------------------------------

export interface CandidateApiKey {
  id: string;
  name: string;
  /** The full secret. Only ever returned to the caller on creation; not stored as-is. */
  key: string;
  active: boolean;
  createdAt: Date | string;
  lastUsedAt: Date | string | null;
}

export interface ApiKeySummary {
  id: string;
  prefix: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/**
 * Strip the secret from an API key row, leaving operator-readable metadata
 * (name, prefix, last-used). Used when reusing an existing key — caller is
 * expected to already have the secret stored locally.
 */
export function summarizeApiKey(k: CandidateApiKey): ApiKeySummary {
  return {
    id: k.id,
    prefix: k.key.length > 12 ? `${k.key.slice(0, 12)}…` : k.key,
    name: k.name,
    createdAt: toIso(k.createdAt),
    lastUsedAt: k.lastUsedAt ? toIso(k.lastUsedAt) : null,
  };
}

/**
 * Pick the canonical active key for a tenant: most recently used, else most
 * recently created. Returns null when the tenant has no active key.
 */
export function selectActiveApiKey(
  candidates: CandidateApiKey[],
): CandidateApiKey | null {
  const active = candidates.filter((k) => k.active);
  if (active.length === 0) return null;
  active.sort((a, b) => {
    const aLu = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
    const bLu = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
    if (aLu !== bLu) return bLu - aLu;
    const aCa = new Date(a.createdAt).getTime();
    const bCa = new Date(b.createdAt).getTime();
    if (aCa !== bCa) return bCa - aCa;
    return a.id.localeCompare(b.id);
  });
  return active[0];
}

function toIso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}
