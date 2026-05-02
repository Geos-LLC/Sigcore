import {
  CandidateApiKey,
  CandidateTenant,
  isAnchorProvisionInput,
  selectActiveApiKey,
  selectExistingTenant,
  summarizeApiKey,
  validateProvisionInput,
} from './idempotent-provisioning.helpers';

describe('isAnchorProvisionInput', () => {
  it('rejects anchor displayName values (case/whitespace insensitive)', () => {
    expect(isAnchorProvisionInput({ externalTenantId: 'sa-real', displayName: 'LeadBridge' })).toBe(true);
    expect(isAnchorProvisionInput({ externalTenantId: 'sa-real', displayName: '  service flow  ' })).toBe(true);
    expect(isAnchorProvisionInput({ externalTenantId: 'sa-real', displayName: 'Callio' })).toBe(true);
    expect(isAnchorProvisionInput({ externalTenantId: 'sa-real', displayName: 'HireFunnel' })).toBe(true);
  });

  it('rejects anchor-prefixed external ids (e.g. leadbridge-4xtm)', () => {
    expect(isAnchorProvisionInput({ externalTenantId: 'leadbridge-4xtm' })).toBe(true);
    expect(isAnchorProvisionInput({ externalTenantId: 'callio_test' })).toBe(true);
  });

  it('passes for real customer inputs', () => {
    expect(
      isAnchorProvisionInput({
        externalTenantId: 'sa_5b8a9ba9-de42-453f-85c4-a38ebb5ba4db',
        displayName: 'Spotless Homes Tampa',
      }),
    ).toBe(false);
  });
});

describe('validateProvisionInput', () => {
  it('returns ok=true with normalized values for valid input', () => {
    const r = validateProvisionInput({
      externalTenantId: '  sa-uuid  ',
      displayName: '  Spotless Homes Tampa  ',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      externalTenantId: 'sa-uuid',
      displayName: 'Spotless Homes Tampa',
      allowInactive: false,
      forceNewKey: false,
    });
  });

  it('falls back displayName to externalTenantId when omitted', () => {
    const r = validateProvisionInput({ externalTenantId: 'sa-uuid' });
    if (!r.ok) throw new Error('expected ok');
    expect(r.value.displayName).toBe('sa-uuid');
  });

  it('errors on missing/empty externalTenantId', () => {
    const r = validateProvisionInput({ externalTenantId: '   ' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('missing_external_tenant_id');
  });

  it('errors on anchor input', () => {
    const r = validateProvisionInput({
      externalTenantId: 'sa-uuid',
      displayName: 'LeadBridge',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('anchor_input_rejected');
  });
});

describe('selectExistingTenant', () => {
  const ACTIVE: CandidateTenant = { id: 't-active', status: 'active', name: 'Spotless Homes Tampa' };
  const INACTIVE: CandidateTenant = { id: 't-inactive', status: 'inactive', name: 'Spotless Homes Tampa' };
  const ANCHOR: CandidateTenant = { id: 't-anchor', status: 'active', name: 'LeadBridge' };

  it('empty list → create_new', () => {
    const r = selectExistingTenant([], { allowInactive: false });
    expect(r.decision).toBe('create_new');
  });

  it('one active candidate → reuse', () => {
    const r = selectExistingTenant([ACTIVE], { allowInactive: false });
    expect(r.decision).toBe('reuse');
    expect(r.tenantId).toBe('t-active');
  });

  it('inactive only without allowInactive → reject (caller can opt in)', () => {
    const r = selectExistingTenant([INACTIVE], { allowInactive: false });
    expect(r.decision).toBe('reject');
    expect(r.reason).toMatch(/inactive/);
  });

  it('inactive only with allowInactive=true → reuse', () => {
    const r = selectExistingTenant([INACTIVE], { allowInactive: true });
    expect(r.decision).toBe('reuse');
    expect(r.tenantId).toBe('t-inactive');
  });

  it('anchor tenant in candidates → reject (defensive)', () => {
    const r = selectExistingTenant([ANCHOR], { allowInactive: false });
    expect(r.decision).toBe('reject');
    expect(r.reason).toMatch(/anchor/);
  });

  it('mixed active candidates → deterministic id-asc winner', () => {
    const a: CandidateTenant = { id: 't-bbb', status: 'active', name: 'X' };
    const b: CandidateTenant = { id: 't-aaa', status: 'active', name: 'X' };
    const r = selectExistingTenant([a, b], { allowInactive: false });
    expect(r.tenantId).toBe('t-aaa');
  });

  it('mixed active + inactive → prefers active', () => {
    const r = selectExistingTenant([INACTIVE, ACTIVE], { allowInactive: false });
    expect(r.tenantId).toBe('t-active');
  });
});

describe('summarizeApiKey', () => {
  it('truncates the secret to a prefix and never returns the full key', () => {
    const out = summarizeApiKey({
      id: 'k-1',
      key: 'sc_tenant_abcdef0123456789',
      name: 'LeadBridge Key',
      active: true,
      createdAt: new Date('2026-04-01T00:00:00Z'),
      lastUsedAt: new Date('2026-05-01T00:00:00Z'),
    });
    expect(out.prefix).toBe('sc_tenant_ab…');
    expect(out.id).toBe('k-1');
    expect(out.name).toBe('LeadBridge Key');
    expect(out.lastUsedAt).toBe('2026-05-01T00:00:00.000Z');
    expect(JSON.stringify(out)).not.toContain('abcdef0123456789');
  });

  it('handles null lastUsedAt', () => {
    const out = summarizeApiKey({
      id: 'k-1',
      key: 'sc_tenant_xx',
      name: 'k',
      active: true,
      createdAt: '2026-04-01T00:00:00Z',
      lastUsedAt: null,
    });
    expect(out.lastUsedAt).toBeNull();
  });
});

describe('selectActiveApiKey', () => {
  function k(overrides: Partial<CandidateApiKey> = {}): CandidateApiKey {
    return {
      id: 'k1',
      name: 'k',
      key: 'sc_tenant_aaaa',
      active: true,
      createdAt: '2026-01-01T00:00:00Z',
      lastUsedAt: null,
      ...overrides,
    };
  }

  it('returns null when no active keys', () => {
    expect(selectActiveApiKey([k({ active: false })])).toBeNull();
    expect(selectActiveApiKey([])).toBeNull();
  });

  it('prefers most-recently-used active key', () => {
    const out = selectActiveApiKey([
      k({ id: 'k-old', lastUsedAt: '2026-01-01T00:00:00Z' }),
      k({ id: 'k-new', lastUsedAt: '2026-05-01T00:00:00Z' }),
    ]);
    expect(out?.id).toBe('k-new');
  });

  it('falls back to most-recently-created when lastUsedAt is null on all', () => {
    const out = selectActiveApiKey([
      k({ id: 'k-old', createdAt: '2026-01-01T00:00:00Z' }),
      k({ id: 'k-new', createdAt: '2026-05-01T00:00:00Z' }),
    ]);
    expect(out?.id).toBe('k-new');
  });

  it('skips inactive keys', () => {
    const out = selectActiveApiKey([
      k({ id: 'k-inactive', active: false, lastUsedAt: '2026-05-01T00:00:00Z' }),
      k({ id: 'k-active', active: true, lastUsedAt: '2026-01-01T00:00:00Z' }),
    ]);
    expect(out?.id).toBe('k-active');
  });
});
