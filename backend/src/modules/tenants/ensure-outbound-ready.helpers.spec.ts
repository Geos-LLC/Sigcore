import { ensureOutboundReadyForTenantPhone, TenantSignals } from './ensure-outbound-ready.helpers';
import { AssignmentRole } from '../../database/entities/profile-phone-assignment.entity';

/**
 * Coverage for ensureOutboundReadyForTenantPhone — the helper that PR1 was
 * missing for post-4/30 phone purchases. The contract is:
 *
 *   - new tenant (no business / no profile)              → all three rows inserted
 *   - tenant with business but no default profile        → profile + PPA inserted, default_profile_id pinned
 *   - tenant with default profile but no PPA             → PPA inserted only
 *   - full chain already present (re-run)                → no writes (changed=false)
 *   - second phone under the same default profile        → PPA inserted with is_default=false
 *   - outbound resolution succeeds (replicates the SQL the resolver runs)
 */

const WS = '1bcbb4e0-df1b-481c-83ba-0730df47a720';
const TENANT = '7ae06bb6-90ee-475f-8346-289b11912e3f';
const TPN_ID = 'cb9fcb01-e5aa-40a4-8b7c-9e436b17bd73';

const TENANT_LB: TenantSignals = {
  name: 'Globus Service',
  externalId: 'bd6a40cc-some-saved-account-id',
  webhookUrls: ['https://thumbtack-bridge-production.up.railway.app/api/webhooks/sigcore/sms'],
  apiKeyNames: ['LeadBridge Key'],
};

interface Row {
  id: string;
  [k: string]: any;
}

function makeRepo(initial: Row[] = []) {
  const rows = [...initial];
  let nextId = 1;
  const newId = (prefix: string) => `${prefix}-${nextId++}`;
  const matches = (where: any, row: Row) =>
    Object.entries(where).every(([k, v]) => row[k] === v);
  return {
    rows,
    findOne: jest.fn(async ({ where }: any) => rows.find((r) => matches(where, r)) ?? null),
    find: jest.fn(async ({ where }: any) => rows.filter((r) => matches(where, r))),
    create: jest.fn((data: any) => ({ ...data })),
    save: jest.fn(async (entity: any) => {
      if (entity.id) {
        const idx = rows.findIndex((r) => r.id === entity.id);
        if (idx >= 0) {
          rows[idx] = { ...rows[idx], ...entity };
          return rows[idx];
        }
        rows.push(entity);
        return entity;
      }
      // Tag by repo identity via outer closure — caller passes through
      const created = { ...entity, id: newId('row') };
      rows.push(created);
      return created;
    }),
  };
}

function makeRepos() {
  const business = makeRepo();
  const profile = makeRepo();
  const ppa = makeRepo();
  // Give the save fakes meaningful prefixes so traces are readable
  business.save.mockImplementation(async (entity: any) => {
    if (entity.id) {
      const idx = business.rows.findIndex((r) => r.id === entity.id);
      if (idx >= 0) {
        business.rows[idx] = { ...business.rows[idx], ...entity };
        return business.rows[idx];
      }
    }
    const created = { ...entity, id: `biz-${business.rows.length + 1}` };
    business.rows.push(created);
    return created;
  });
  profile.save.mockImplementation(async (entity: any) => {
    if (entity.id) {
      const idx = profile.rows.findIndex((r) => r.id === entity.id);
      if (idx >= 0) {
        profile.rows[idx] = { ...profile.rows[idx], ...entity };
        return profile.rows[idx];
      }
    }
    const created = { ...entity, id: `prof-${profile.rows.length + 1}` };
    profile.rows.push(created);
    return created;
  });
  ppa.save.mockImplementation(async (entity: any) => {
    if (entity.id) {
      const idx = ppa.rows.findIndex((r) => r.id === entity.id);
      if (idx >= 0) {
        ppa.rows[idx] = { ...ppa.rows[idx], ...entity };
        return ppa.rows[idx];
      }
    }
    const created = { ...entity, id: `ppa-${ppa.rows.length + 1}` };
    ppa.rows.push(created);
    return created;
  });
  return { business: business as any, profile: profile as any, ppa: ppa as any };
}

function tpn(overrides: Partial<{ id: string; workspaceId: string; tenantId: string }> = {}) {
  return {
    id: TPN_ID,
    workspaceId: WS,
    tenantId: TENANT,
    ...overrides,
  };
}

describe('ensureOutboundReadyForTenantPhone', () => {
  it('new tenant: creates business + default profile + PPA, pins default_profile_id', async () => {
    const repos = makeRepos();

    const result = await ensureOutboundReadyForTenantPhone(repos, tpn(), TENANT_LB);

    expect(result.changed).toBe(true);
    expect(repos.business.rows).toHaveLength(1);
    expect(repos.business.rows[0]).toMatchObject({
      tenantId: TENANT,
      workspaceId: WS,
      slug: 'globus-service-7ae06bb6',
      displayName: 'Globus Service',
      // LB tenant — external_business_id carries the tenant's external_id
      externalBusinessId: TENANT_LB.externalId,
      status: 'active',
      defaultProfileId: result.profileId,
    });
    expect(repos.profile.rows).toHaveLength(1);
    expect(repos.profile.rows[0]).toMatchObject({
      tenantId: TENANT,
      communicationBusinessId: result.businessId,
      slug: 'default',
      source: 'leadbridge',
      isDefault: true,
    });
    expect(repos.ppa.rows).toHaveLength(1);
    expect(repos.ppa.rows[0]).toMatchObject({
      profileId: result.profileId,
      tenantPhoneNumberId: TPN_ID,
      role: AssignmentRole.PRIMARY,
      isDefault: true,
      priority: 100,
      active: true,
    });
  });

  it('business exists but no profile: inserts profile + PPA and pins default_profile_id', async () => {
    const repos = makeRepos();
    repos.business.rows.push({
      id: 'biz-existing',
      tenantId: TENANT,
      workspaceId: WS,
      slug: 'globus-service-7ae06bb6',
      displayName: 'Globus Service',
      status: 'active',
      defaultProfileId: null,
    });

    const result = await ensureOutboundReadyForTenantPhone(repos, tpn(), TENANT_LB);

    expect(result.businessId).toBe('biz-existing');
    expect(repos.profile.rows).toHaveLength(1);
    expect(repos.ppa.rows).toHaveLength(1);
    expect(repos.business.rows[0].defaultProfileId).toBe(result.profileId);
    expect(result.changed).toBe(true);
  });

  it('business + default profile exist but no PPA: inserts PPA only', async () => {
    const repos = makeRepos();
    repos.business.rows.push({
      id: 'biz-1',
      tenantId: TENANT,
      workspaceId: WS,
      slug: 'globus-service-7ae06bb6',
      displayName: 'Globus Service',
      status: 'active',
      defaultProfileId: 'prof-1',
    });
    repos.profile.rows.push({
      id: 'prof-1',
      tenantId: TENANT,
      workspaceId: WS,
      communicationBusinessId: 'biz-1',
      slug: 'default',
      source: 'leadbridge',
      isDefault: true,
      status: 'active',
    });

    const result = await ensureOutboundReadyForTenantPhone(repos, tpn(), TENANT_LB);

    expect(result.businessId).toBe('biz-1');
    expect(result.profileId).toBe('prof-1');
    expect(repos.ppa.rows).toHaveLength(1);
    expect(repos.ppa.rows[0]).toMatchObject({
      profileId: 'prof-1',
      tenantPhoneNumberId: TPN_ID,
      isDefault: true, // first PPA under the profile becomes default
      active: true,
    });
    expect(result.changed).toBe(true);
  });

  it('full chain already present: re-run is a true no-op (changed=false)', async () => {
    const repos = makeRepos();
    repos.business.rows.push({
      id: 'biz-1',
      tenantId: TENANT,
      workspaceId: WS,
      slug: 'globus-service-7ae06bb6',
      displayName: 'Globus Service',
      status: 'active',
      defaultProfileId: 'prof-1',
    });
    repos.profile.rows.push({
      id: 'prof-1',
      tenantId: TENANT,
      workspaceId: WS,
      communicationBusinessId: 'biz-1',
      slug: 'default',
      source: 'leadbridge',
      isDefault: true,
      status: 'active',
    });
    repos.ppa.rows.push({
      id: 'ppa-1',
      profileId: 'prof-1',
      tenantPhoneNumberId: TPN_ID,
      role: AssignmentRole.PRIMARY,
      isDefault: true,
      priority: 100,
      active: true,
    });

    const result = await ensureOutboundReadyForTenantPhone(repos, tpn(), TENANT_LB);

    expect(result.changed).toBe(false);
    expect(repos.business.save).not.toHaveBeenCalled();
    expect(repos.profile.save).not.toHaveBeenCalled();
    expect(repos.ppa.save).not.toHaveBeenCalled();
    expect(repos.business.rows).toHaveLength(1);
    expect(repos.profile.rows).toHaveLength(1);
    expect(repos.ppa.rows).toHaveLength(1);
  });

  it('second phone under the same profile: new PPA is_default=false', async () => {
    const repos = makeRepos();
    repos.business.rows.push({
      id: 'biz-1',
      tenantId: TENANT,
      workspaceId: WS,
      slug: 'globus-service-7ae06bb6',
      displayName: 'Globus Service',
      status: 'active',
      defaultProfileId: 'prof-1',
    });
    repos.profile.rows.push({
      id: 'prof-1',
      tenantId: TENANT,
      workspaceId: WS,
      communicationBusinessId: 'biz-1',
      slug: 'default',
      source: 'leadbridge',
      isDefault: true,
      status: 'active',
    });
    repos.ppa.rows.push({
      id: 'ppa-existing-default',
      profileId: 'prof-1',
      tenantPhoneNumberId: 'first-tpn',
      role: AssignmentRole.PRIMARY,
      isDefault: true,
      priority: 100,
      active: true,
    });

    const secondTpn = tpn({ id: 'second-tpn' });
    const result = await ensureOutboundReadyForTenantPhone(repos, secondTpn, TENANT_LB);

    expect(result.changed).toBe(true);
    expect(repos.ppa.rows).toHaveLength(2);
    const inserted = repos.ppa.rows.find((r: any) => r.tenantPhoneNumberId === 'second-tpn')!;
    expect(inserted.isDefault).toBe(false);
    expect(inserted.role).toBe(AssignmentRole.PRIMARY);
    expect(inserted.active).toBe(true);
  });

  it('non-LB tenant: external_business_id is NULL on the business row', async () => {
    const repos = makeRepos();
    const internalSignals: TenantSignals = {
      name: 'Some Internal Tenant',
      externalId: 'whatever-external-id',
      webhookUrls: [],
      apiKeyNames: [],
    };

    await ensureOutboundReadyForTenantPhone(repos, tpn(), internalSignals);

    expect(repos.business.rows[0].externalBusinessId).toBeNull();
    expect(repos.profile.rows[0].source).toBe('internal');
  });

  // Lavanda regression (2026-09-17). Reproduces the exact pre-seed that
  // caused +16193303608 to end up with two active PPAs on the same tenant
  // after the 2026-08-13 channels-PATCH hit ensureOutboundReady. The
  // pre-existing source-specific profile owned an active PPA to the TPN;
  // this helper used to insert a second Default PPA regardless, breaking
  // outbound resolution with AMBIGUOUS_FROM_NUMBER. It must now no-op the
  // PPA insertion and return the source-specific profile's identity.
  it('lavanda regression: active source-specific PPA on TPN suppresses Default PPA insertion, returns source profile id', async () => {
    const repos = makeRepos();
    repos.business.rows.push({
      id: 'biz-lavanda',
      tenantId: TENANT,
      workspaceId: WS,
      slug: 'lavanda-cleaning-7ae06bb6',
      displayName: 'Lavanda Cleaning',
      status: 'active',
      defaultProfileId: 'prof-default-lavanda',
    });
    repos.profile.rows.push({
      id: 'prof-default-lavanda',
      tenantId: TENANT,
      workspaceId: WS,
      communicationBusinessId: 'biz-lavanda',
      slug: 'default',
      source: 'leadbridge',
      isDefault: false, // Lavanda's real data: Default is not isDefault=true
      status: 'active',
      createdAt: new Date('2026-05-01T02:51:17Z'),
    });
    repos.profile.rows.push({
      id: 'prof-thumbtack-lavanda',
      tenantId: TENANT,
      workspaceId: WS,
      communicationBusinessId: 'biz-lavanda',
      slug: 'thumbtack-lavanda-cleaning',
      source: 'thumbtack',
      externalProfileId: '530741472395919364',
      isDefault: true, // the canonical source-specific profile carries is_default=TRUE
      status: 'active',
      createdAt: new Date('2026-05-01T23:07:48Z'),
    });
    repos.ppa.rows.push({
      id: 'ppa-thumbtack-lavanda',
      profileId: 'prof-thumbtack-lavanda',
      tenantPhoneNumberId: TPN_ID,
      role: AssignmentRole.PRIMARY,
      isDefault: true,
      priority: 100,
      active: true,
    });

    const result = await ensureOutboundReadyForTenantPhone(repos, tpn(), {
      name: 'Lavanda Cleaning',
      externalId: '5b8a9ba9-de42-453f-85c4-a38ebb5ba4db',
      webhookUrls: ['https://thumbtack-bridge-production.up.railway.app/api/webhooks/sigcore/sms'],
      apiKeyNames: ['LeadBridge Key'],
    });

    // No second PPA inserted on the shared TPN.
    const activeOnTpn = repos.ppa.rows.filter((r: any) => r.tenantPhoneNumberId === TPN_ID && r.active);
    expect(activeOnTpn).toHaveLength(1);
    expect(activeOnTpn[0].id).toBe('ppa-thumbtack-lavanda');
    expect(activeOnTpn[0].profileId).toBe('prof-thumbtack-lavanda');

    // Result surfaces the canonical (source-specific) sender identity, NOT
    // the Default profile — so callers persisting sigcoreProfileId anchor
    // to the profile that actually owns the outbound path.
    expect(result.profileId).toBe('prof-thumbtack-lavanda');
    expect(result.ppaId).toBe('ppa-thumbtack-lavanda');

    // Resolver simulation: outbound from TPN under this tenant resolves to
    // exactly one profile. Same shape as
    // resolve-profile-for-outbound.service.ts step B (phone-only path).
    const profilesForTenant = repos.profile.rows.filter((p: any) => p.tenantId === TENANT);
    const profileIds = new Set(profilesForTenant.map((p: any) => p.id));
    const matchingPpas = repos.ppa.rows.filter(
      (p: any) => profileIds.has(p.profileId) && p.tenantPhoneNumberId === TPN_ID && p.active,
    );
    expect(matchingPpas).toHaveLength(1);
  });

  // Cross-tenant PPA on the same TPN is a legitimate shared-assignment case
  // (phone-assignments.service.ts PR15). It MUST NOT suppress Default
  // materialization for the calling tenant — the calling tenant needs its
  // own outbound identity for the TPN.
  it('cross-tenant boundary: active PPA under a DIFFERENT tenant\'s profile does not suppress Default materialization', async () => {
    const repos = makeRepos();
    const OTHER_TENANT = 'ffffffff-0000-0000-0000-000000000001';
    repos.business.rows.push({
      id: 'biz-other',
      tenantId: OTHER_TENANT,
      workspaceId: WS,
      slug: 'other-tenant-ffffffff',
      displayName: 'Other Tenant',
      status: 'active',
      defaultProfileId: 'prof-other-default',
    });
    repos.profile.rows.push({
      id: 'prof-other-default',
      tenantId: OTHER_TENANT,
      workspaceId: WS,
      communicationBusinessId: 'biz-other',
      slug: 'default',
      source: 'leadbridge',
      isDefault: true,
      status: 'active',
      createdAt: new Date('2026-05-01T00:00:00Z'),
    });
    repos.ppa.rows.push({
      id: 'ppa-other-tenant',
      profileId: 'prof-other-default',
      tenantPhoneNumberId: TPN_ID,
      role: AssignmentRole.PRIMARY,
      isDefault: true,
      priority: 100,
      active: true,
    });

    const result = await ensureOutboundReadyForTenantPhone(repos, tpn(), TENANT_LB);

    // Default was materialized for the CALLING tenant (business + profile +
    // its own PPA), independent of the cross-tenant PPA.
    expect(result.changed).toBe(true);
    const callingBiz = repos.business.rows.find((b: any) => b.tenantId === TENANT);
    expect(callingBiz).toBeDefined();
    expect(result.businessId).toBe(callingBiz!.id);
    const callingProfile = repos.profile.rows.find(
      (p: any) => p.tenantId === TENANT && p.slug === 'default',
    );
    expect(callingProfile).toBeDefined();
    expect(result.profileId).toBe(callingProfile!.id);
    // Two active PPAs on the TPN — one per tenant. The resolver joins by
    // p.tenant_id, so this is unambiguous per-tenant.
    const activeOnTpn = repos.ppa.rows.filter((r: any) => r.tenantPhoneNumberId === TPN_ID && r.active);
    expect(activeOnTpn).toHaveLength(2);
    expect(activeOnTpn.map((r: any) => r.profileId).sort()).toEqual(
      [callingProfile!.id, 'prof-other-default'].sort(),
    );
  });

  // Inactive (archived/suspended) profile with a dangling active PPA in the
  // same tenant is NOT outbound-ready. The guard must not honor it —
  // otherwise repair paths that leave a dead profile behind would suppress
  // Default materialization forever.
  it('inactive profile in same tenant: active PPA does not suppress Default materialization', async () => {
    const repos = makeRepos();
    repos.business.rows.push({
      id: 'biz-1',
      tenantId: TENANT,
      workspaceId: WS,
      slug: 'globus-service-7ae06bb6',
      displayName: 'Globus Service',
      status: 'active',
      defaultProfileId: null,
    });
    repos.profile.rows.push({
      id: 'prof-archived',
      tenantId: TENANT,
      workspaceId: WS,
      communicationBusinessId: 'biz-1',
      slug: 'thumbtack-legacy',
      source: 'thumbtack',
      isDefault: false,
      status: 'inactive', // deactivated / archived
      createdAt: new Date('2026-05-01T00:00:00Z'),
    });
    repos.ppa.rows.push({
      id: 'ppa-archived',
      profileId: 'prof-archived',
      tenantPhoneNumberId: TPN_ID,
      role: AssignmentRole.PRIMARY,
      isDefault: true,
      priority: 100,
      active: true, // dangling active PPA on an inactive profile
    });

    const result = await ensureOutboundReadyForTenantPhone(repos, tpn(), TENANT_LB);

    // Default WAS materialized — the archived profile does not count.
    expect(result.changed).toBe(true);
    const defaultProfile = repos.profile.rows.find(
      (p: any) => p.slug === 'default' && p.tenantId === TENANT,
    );
    expect(defaultProfile).toBeDefined();
    expect(result.profileId).toBe(defaultProfile!.id);
    // Two active PPAs exist on the TPN (dangling + fresh Default), but
    // only one lives under an ACTIVE profile in this tenant. The resolver
    // joins on p.status via caller code; documenting expectation here.
    const activeOnTpn = repos.ppa.rows.filter((r: any) => r.tenantPhoneNumberId === TPN_ID && r.active);
    expect(activeOnTpn.map((r: any) => r.profileId).sort()).toEqual(
      [defaultProfile!.id, 'prof-archived'].sort(),
    );
  });

  it('outbound-resolution shape: after run, (tpn.phone_number, profile.tenant_id, ppa.active=true) match', async () => {
    // Mirrors the SQL in resolve-profile-for-outbound.service.ts
    const repos = makeRepos();

    const t = tpn();
    const result = await ensureOutboundReadyForTenantPhone(repos, t, TENANT_LB);

    // Simulate the resolver's join: find ppa rows where the PPA's profile has
    // p.tenant_id = caller_tenant AND ppa.active = TRUE AND the joined TPN's
    // phone_number matches. Here we model the join by matching the PPA's
    // tenantPhoneNumberId to the TPN id and the profile's tenantId to the
    // caller tenant.
    const callerTenant = TENANT;
    const profilesForTenant = repos.profile.rows.filter((p: any) => p.tenantId === callerTenant);
    const profileIds = new Set(profilesForTenant.map((p: any) => p.id));
    const matchingPpas = repos.ppa.rows.filter(
      (p: any) => profileIds.has(p.profileId) && p.tenantPhoneNumberId === t.id && p.active,
    );

    expect(matchingPpas).toHaveLength(1);
    expect(matchingPpas[0].id).toBe(result.ppaId);
  });
});
