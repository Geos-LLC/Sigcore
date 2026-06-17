/**
 * Idempotently materialize the (CommunicationBusiness, default
 * CommunicationProfile, ProfilePhoneAssignment) chain that PR1 added
 * on 2026-04-30 — so a freshly purchased TenantPhoneNumber is
 * outbound-ready without any out-of-band backfill.
 *
 * Outbound resolution (resolve-profile-for-outbound.service.ts) requires
 * an active PPA matching (fromNumber, calling tenant). The migration
 * 1764000100000-BackfillBusinessesProfilesAssignments seeded those rows
 * for the pre-existing fleet; this helper does the equivalent on every
 * subsequent purchase so the invariant lives in the code path, not in
 * one-off scripts.
 *
 * Pure DB orchestration — kept module-local and split into small steps
 * so the spec can exercise each branch (no business, business but no
 * profile, profile but no PPA, full chain already present, second phone
 * under the same profile) without standing up the whole DataSource.
 *
 * NOTE: Sources of truth shared with the original backfill migration:
 *   - classifyTenantSource + makeSlug live in
 *     database/migrations/_helpers/source-classifier so reads here match
 *     the backfilled rows exactly (same slug shape, same source
 *     classification). Do not fork.
 */

import { Repository } from 'typeorm';
import { CommunicationBusiness } from '../../database/entities/communication-business.entity';
import { CommunicationProfile } from '../../database/entities/communication-profile.entity';
import { ProfilePhoneAssignment, AssignmentRole } from '../../database/entities/profile-phone-assignment.entity';
import { TenantPhoneNumber } from '../../database/entities/tenant-phone-number.entity';
import {
  classifyTenantSource,
  makeSlug,
  ProfileSourceValue,
} from '../../database/migrations/_helpers/source-classifier';

export interface TenantSignals {
  /** Tenant.name as stored on tenants.name. May be null/empty. */
  name: string | null;
  /** Tenant.external_id — preserved on the business when source='leadbridge'. */
  externalId: string | null;
  /** webhook_subscriptions.webhook_url values for this tenant (any status). */
  webhookUrls: string[];
  /** api_keys.name values for this tenant (any status). */
  apiKeyNames: string[];
}

export interface EnsureOutboundReadyRepos {
  business: Repository<CommunicationBusiness>;
  profile: Repository<CommunicationProfile>;
  ppa: Repository<ProfilePhoneAssignment>;
}

export interface EnsureOutboundReadyResult {
  businessId: string;
  profileId: string;
  ppaId: string;
  /** True only when this call inserted/updated at least one row. */
  changed: boolean;
}

/**
 * Idempotently ensure the chain exists for `tpn`. Safe to call repeatedly.
 *
 * The four touched tables and their idempotency keys:
 *   communication_businesses    — (tenant_id, slug)            unique
 *   communication_profiles      — (business_id, slug='default') unique
 *   communication_businesses.default_profile_id — pinned to default profile
 *   profile_phone_assignments   — (profile_id, tpn_id)         unique
 *
 * is_default semantics for the PPA: PR1's partial-unique index
 * `IDX_ppa_default_per_profile` requires AT MOST ONE active assignment
 * per profile carries is_default=TRUE. We mark the first phone under
 * the profile as default and every subsequent phone as non-default.
 */
export async function ensureOutboundReadyForTenantPhone(
  repos: EnsureOutboundReadyRepos,
  tpn: Pick<TenantPhoneNumber, 'id' | 'workspaceId' | 'tenantId'>,
  signals: TenantSignals,
): Promise<EnsureOutboundReadyResult> {
  const source: ProfileSourceValue = classifyTenantSource(
    signals.name,
    signals.webhookUrls,
    signals.apiKeyNames,
  );
  const slug = makeSlug(signals.name, tpn.tenantId);
  const displayName = (signals.name ?? '').trim() || `Workspace ${tpn.tenantId.slice(0, 8)}`;
  // Match the migration: external_business_id is only populated for LB tenants.
  const externalBusinessId = source === 'leadbridge' ? signals.externalId ?? null : null;

  let changed = false;

  // 1. communication_businesses
  let business = await repos.business.findOne({
    where: { tenantId: tpn.tenantId, slug },
  });
  if (!business) {
    // Keep the field explicitly nullable (not undefined) so the in-memory
    // entity matches the DB shape the migration produced — handy for tests
    // and for any caller inspecting the row right after insert.
    business = repos.business.create({
      workspaceId: tpn.workspaceId,
      tenantId: tpn.tenantId,
      externalBusinessId: externalBusinessId as any,
      displayName,
      slug,
      status: 'active',
    });
    business = await repos.business.save(business);
    changed = true;
  }

  // 2. default communication_profiles row
  let profile = await repos.profile.findOne({
    where: { communicationBusinessId: business.id, slug: 'default' },
  });
  if (!profile) {
    profile = repos.profile.create({
      workspaceId: tpn.workspaceId,
      tenantId: tpn.tenantId,
      communicationBusinessId: business.id,
      source,
      displayName: 'Default',
      slug: 'default',
      status: 'active',
      isDefault: true,
    });
    profile = await repos.profile.save(profile);
    changed = true;
  }

  // 3. pin default_profile_id on the business if drifted
  if (business.defaultProfileId !== profile.id) {
    business.defaultProfileId = profile.id;
    await repos.business.save(business);
    changed = true;
  }

  // 4. profile_phone_assignments — (profile_id, tpn_id) is the idempotency key
  let ppa = await repos.ppa.findOne({
    where: { profileId: profile.id, tenantPhoneNumberId: tpn.id },
  });
  if (!ppa) {
    // Partial-unique IDX_ppa_default_per_profile: only the first active
    // assignment under this profile may carry is_default=TRUE.
    const existingDefault = await repos.ppa.findOne({
      where: { profileId: profile.id, isDefault: true, active: true },
    });
    ppa = repos.ppa.create({
      profileId: profile.id,
      tenantPhoneNumberId: tpn.id,
      role: AssignmentRole.PRIMARY,
      isDefault: !existingDefault,
      priority: 100,
      active: true,
    });
    ppa = await repos.ppa.save(ppa);
    changed = true;
  }

  return {
    businessId: business.id,
    profileId: profile.id,
    ppaId: ppa.id,
    changed,
  };
}
