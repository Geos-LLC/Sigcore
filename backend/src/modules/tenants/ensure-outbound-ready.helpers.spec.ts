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
