import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommunicationProfile } from '../../database/entities/communication-profile.entity';
import { ProfilePhoneAssignment } from '../../database/entities/profile-phone-assignment.entity';
import { TenantPhoneNumber } from '../../database/entities/tenant-phone-number.entity';
import { RoutingError, RoutingErrorCode } from './routing-errors';

export type OutboundResolutionSource =
  | 'profile_explicit'         // caller provided profileId
  | 'profile_slug'             // caller provided profileSlug
  | 'profile_explicit_phone'   // profileId + fromNumber both provided
  | 'profile_slug_phone'       // profileSlug + fromNumber both provided
  | 'phone_unique';            // only fromNumber, single matching profile

export interface OutboundResolveInput {
  /** Tenant the api key resolves to. Always validated against profile.tenant_id. */
  tenantId: string;

  /** Preferred — explicit profile UUID. */
  profileId?: string;

  /** Alternative — (tenantId, slug) lookup. Slug is unique per business but
   *  we resolve scoped to tenant since that's what the api key authorizes. */
  profileSlug?: string;

  /** Optional — caller-specified sender. Validated against the profile's
   *  phone assignments when a profile is also provided. */
  fromNumber?: string;
}

export interface OutboundResolveResult {
  profileId: string;
  businessId: string;
  fromNumber: string;
  source: OutboundResolutionSource;
}

/**
 * Resolve a (profile, fromNumber) pair for an outbound send.
 *
 * Locked design decisions:
 *   #5 — IDs are the only routing identifiers; names are display-only.
 *   #2 — A phone can be assigned to multiple profiles (M:N).
 *   #9 — profileId required for deterministic behavior; no implicit
 *        default fallback. (We DO accept fromNumber-only as a back-compat
 *        path, but only when it resolves to exactly one active profile.)
 *
 * Throws RoutingError with these codes:
 *   CROSS_TENANT_PROFILE   — provided profile belongs to a different tenant
 *   PROFILE_NOT_FOUND      — profileId or profileSlug doesn't resolve
 *   INVALID_PROFILE_PHONE  — fromNumber not in this profile's assignment set
 *                            (or unknown fromNumber on the phone-only path)
 *   AMBIGUOUS_FROM_NUMBER  — fromNumber-only call but the phone is assigned
 *                            to multiple active profiles, OR neither
 *                            profileId nor fromNumber was provided
 *   PROFILE_NOT_CONFIGURED — profile resolved but has no active phone
 *                            assignment
 *
 * Pure read-only — no writes.
 */
@Injectable()
export class ResolveProfileForOutboundService {
  private readonly logger = new Logger(ResolveProfileForOutboundService.name);

  constructor(
    @InjectRepository(CommunicationProfile)
    private readonly profileRepo: Repository<CommunicationProfile>,
    @InjectRepository(ProfilePhoneAssignment)
    private readonly ppaRepo: Repository<ProfilePhoneAssignment>,
    @InjectRepository(TenantPhoneNumber)
    private readonly tpnRepo: Repository<TenantPhoneNumber>,
  ) {}

  async resolve(input: OutboundResolveInput): Promise<OutboundResolveResult> {
    const { tenantId, profileId, profileSlug, fromNumber } = input;

    // Step A — explicit profileId / profileSlug path
    if (profileId || profileSlug) {
      const profile = profileId
        ? await this.profileRepo.findOne({ where: { id: profileId } })
        : await this.profileRepo.findOne({
            where: { tenantId, slug: profileSlug! },
          });

      if (!profile) {
        throw new RoutingError(
          RoutingErrorCode.PROFILE_NOT_FOUND,
          `profile not found: ${profileId ? `id=${profileId}` : `slug=${profileSlug}`}`,
        );
      }
      if (profile.tenantId !== tenantId) {
        throw new RoutingError(
          RoutingErrorCode.CROSS_TENANT_PROFILE,
          `profile ${profile.id} belongs to a different tenant`,
        );
      }

      return await this.pickFromNumberForProfile(profile, fromNumber, profileId ? 'profile_explicit' : 'profile_slug');
    }

    // Step B — fromNumber-only path
    if (fromNumber) {
      // Find every active assignment whose tenant_phone_numbers row matches
      // this fromNumber AND whose profile lives under the calling tenant.
      const matching = await this.ppaRepo
        .createQueryBuilder('ppa')
        .innerJoin(TenantPhoneNumber, 'tpn', 'tpn.id = ppa.tenant_phone_number_id')
        .innerJoin(CommunicationProfile, 'p', 'p.id = ppa.profile_id')
        .where('tpn.phone_number = :phone', { phone: fromNumber })
        .andWhere('p.tenant_id = :tenantId', { tenantId })
        .andWhere('ppa.active = TRUE')
        .select([
          'ppa.id AS ppa_id',
          'ppa.profile_id AS profile_id',
          'p.communication_business_id AS business_id',
        ])
        .getRawMany<{ ppa_id: string; profile_id: string; business_id: string }>();

      if (matching.length === 0) {
        throw new RoutingError(
          RoutingErrorCode.INVALID_PROFILE_PHONE,
          `fromNumber ${fromNumber} is not assigned to any profile under this tenant`,
        );
      }
      if (matching.length > 1) {
        throw new RoutingError(
          RoutingErrorCode.AMBIGUOUS_FROM_NUMBER,
          `fromNumber ${fromNumber} is shared by ${matching.length} profiles — pass profileId explicitly`,
        );
      }
      const m = matching[0];
      return {
        profileId: m.profile_id,
        businessId: m.business_id,
        fromNumber,
        source: 'phone_unique',
      };
    }

    // Step C — nothing provided
    throw new RoutingError(
      RoutingErrorCode.AMBIGUOUS_FROM_NUMBER,
      'either profileId, profileSlug, or fromNumber is required',
    );
  }

  /**
   * Given a resolved profile, pick the actual outbound phone number from
   * its assignment set. Honors caller-provided fromNumber when set
   * (validated to be in the profile's set), otherwise picks the assignment
   * with is_default DESC, priority DESC.
   */
  private async pickFromNumberForProfile(
    profile: CommunicationProfile,
    fromNumberHint: string | undefined,
    baseSource: 'profile_explicit' | 'profile_slug',
  ): Promise<OutboundResolveResult> {
    const assignments = await this.ppaRepo
      .createQueryBuilder('ppa')
      .innerJoin(TenantPhoneNumber, 'tpn', 'tpn.id = ppa.tenant_phone_number_id')
      .where('ppa.profile_id = :pid', { pid: profile.id })
      .andWhere('ppa.active = TRUE')
      .select([
        'ppa.id AS ppa_id',
        'ppa.is_default AS is_default',
        'ppa.priority AS priority',
        'tpn.phone_number AS phone_number',
      ])
      .orderBy('ppa.is_default', 'DESC')
      .addOrderBy('ppa.priority', 'DESC')
      .getRawMany<{
        ppa_id: string;
        is_default: boolean;
        priority: number;
        phone_number: string;
      }>();

    if (assignments.length === 0) {
      throw new RoutingError(
        RoutingErrorCode.PROFILE_NOT_CONFIGURED,
        `profile ${profile.id} has no active phone assignment`,
      );
    }

    if (fromNumberHint) {
      const match = assignments.find((a) => a.phone_number === fromNumberHint);
      if (!match) {
        throw new RoutingError(
          RoutingErrorCode.INVALID_PROFILE_PHONE,
          `fromNumber ${fromNumberHint} is not assigned to profile ${profile.id}`,
        );
      }
      return {
        profileId: profile.id,
        businessId: profile.communicationBusinessId,
        fromNumber: fromNumberHint,
        source:
          baseSource === 'profile_explicit'
            ? 'profile_explicit_phone'
            : 'profile_slug_phone',
      };
    }

    return {
      profileId: profile.id,
      businessId: profile.communicationBusinessId,
      fromNumber: assignments[0].phone_number,
      source: baseSource,
    };
  }
}
