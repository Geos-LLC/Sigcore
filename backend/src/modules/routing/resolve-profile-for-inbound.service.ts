import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CommunicationConversation } from '../../database/entities/communication-conversation.entity';
import { TenantPhoneNumber } from '../../database/entities/tenant-phone-number.entity';
import { ProfilePhoneAssignment } from '../../database/entities/profile-phone-assignment.entity';

export type InboundConfidence = 'sticky' | 'phone_default' | 'unknown';

export interface InboundResolveInput {
  workspaceId: string;
  tenantId: string;
  /** E.164 of the Sigcore-side number that received the inbound message. */
  ourPhone: string;
  /** E.164 of the participant who sent the message. */
  theirPhone: string;
}

export interface InboundResolveResult {
  profileId: string | null;
  businessId: string | null;
  confidence: InboundConfidence;
}

/**
 * Resolve which profile + business an inbound message should be associated
 * with, given (tenant, our_number, their_number).
 *
 * Resolution order (locked decision #8 — stickiness primary):
 *   1. STICKY    — the most recent communication_conversations row matching
 *                  (tenant, ourPhone, theirPhone) — its profile_id wins.
 *   2. PHONE     — fall back to profile_phone_assignments for the receiving
 *                  number, ordered by (is_default DESC, priority DESC).
 *                  If a phone is shared by multiple profiles this picks the
 *                  highest-priority active assignment, deterministically.
 *   3. UNKNOWN   — no match at all. Conversation gets profileId=null and
 *                  the caller decides whether to drop or persist.
 *
 * Pure read-only — no writes. Used by the inbound webhook paths in PR3.
 */
@Injectable()
export class ResolveProfileForInboundService {
  private readonly logger = new Logger(ResolveProfileForInboundService.name);

  constructor(
    @InjectRepository(CommunicationConversation)
    private readonly conversationRepo: Repository<CommunicationConversation>,
    @InjectRepository(TenantPhoneNumber)
    private readonly tpnRepo: Repository<TenantPhoneNumber>,
    @InjectRepository(ProfilePhoneAssignment)
    private readonly ppaRepo: Repository<ProfilePhoneAssignment>,
  ) {}

  async resolve(input: InboundResolveInput): Promise<InboundResolveResult> {
    const { workspaceId, tenantId, ourPhone, theirPhone } = input;

    // Rule 1 — sticky lookup.
    const sticky = await this.conversationRepo.findOne({
      where: {
        workspaceId,
        tenantId,
        phoneNumber: ourPhone,
        participantPhoneNumber: theirPhone,
      },
      order: { createdAt: 'DESC' },
    });

    if (sticky?.communicationProfileId) {
      return {
        profileId: sticky.communicationProfileId,
        businessId: sticky.communicationBusinessId ?? null,
        confidence: 'sticky',
      };
    }

    // Rule 2 — phone-default fallback. Look up the tpn that matches our
    // (tenantId, phoneNumber) tuple, then pick the highest-priority active
    // assignment for that phone.
    const tpn = await this.tpnRepo.findOne({
      where: { workspaceId, tenantId, phoneNumber: ourPhone },
    });
    if (tpn) {
      const ppa = await this.ppaRepo.findOne({
        where: { tenantPhoneNumberId: tpn.id, active: true },
        relations: ['profile'],
        order: { isDefault: 'DESC', priority: 'DESC' },
      });
      if (ppa?.profile) {
        return {
          profileId: ppa.profileId,
          businessId: ppa.profile.communicationBusinessId,
          confidence: 'phone_default',
        };
      }
    }

    // Rule 3 — unknown.
    this.logger.warn(
      `[inbound] no profile match for tenant=${tenantId} our=${ourPhone} their=${theirPhone}`,
    );
    return { profileId: null, businessId: null, confidence: 'unknown' };
  }
}
