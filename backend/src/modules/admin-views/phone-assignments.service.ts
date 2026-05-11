import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { CommunicationProfile } from '../../database/entities/communication-profile.entity';
import {
  ProfilePhoneAssignment,
  AssignmentRole,
} from '../../database/entities/profile-phone-assignment.entity';
import { TenantPhoneNumber } from '../../database/entities/tenant-phone-number.entity';
import { PhoneNumberProvisioningService } from '../tenants/phone-number-provisioning.service';

export interface AvailablePhoneRow {
  tenantPhoneNumberId: string;
  phoneNumber: string;
  provider: string;
  channel: string;
  status: string;
  friendlyName: string | null;
  a2pStatus: string | null;
  /** True if this phone is already actively assigned to this profile. */
  alreadyAssignedToThisProfile: boolean;
  /** Other profiles in the workspace that already share this phone. */
  sharedWithProfileIds: string[];
}

export interface AssignedRow {
  id: string;
  profileId: string;
  tenantPhoneNumberId: string;
  phoneNumber: string;
  provider: string;
  role: string;
  isDefault: boolean;
  priority: number;
  active: boolean;
}

export interface AssignDto {
  profileId: string;
  tenantPhoneNumberId?: string;
  /** Alternative to tenantPhoneNumberId — looked up via (workspaceId, phoneNumber). */
  phoneNumber?: string;
  role?: AssignmentRole | string;
  isDefault?: boolean;
  priority?: number;
}

export type ProvisionProvider = 'twilio';

export interface ProvisionAndAssignDto {
  tenantId: string;
  profileId: string;
  provider?: ProvisionProvider;
  areaCode?: string;
  locality?: string;
  region?: string;
  country?: string;
  capabilities?: Array<'sms' | 'voice'>;
  makeDefault?: boolean;
  orderedBy?: string;
}

export interface ProvisionAndAssignResult {
  tenantPhoneNumber: TenantPhoneNumber;
  profilePhoneAssignment: AssignedRow;
  purchased: boolean;
  assigned: boolean;
}

@Injectable()
export class PhoneAssignmentsService {
  private readonly logger = new Logger(PhoneAssignmentsService.name);

  constructor(
    @InjectRepository(CommunicationProfile)
    private readonly profileRepo: Repository<CommunicationProfile>,
    @InjectRepository(TenantPhoneNumber)
    private readonly tpnRepo: Repository<TenantPhoneNumber>,
    @InjectRepository(ProfilePhoneAssignment)
    private readonly ppaRepo: Repository<ProfilePhoneAssignment>,
    private readonly dataSource: DataSource,
    private readonly provisioning: PhoneNumberProvisioningService,
  ) {}

  async listAvailableForProfile(
    workspaceId: string,
    profileId: string,
  ): Promise<{ profileId: string; rows: AvailablePhoneRow[] }> {
    const profile = await this.profileRepo.findOne({
      where: { id: profileId, workspaceId },
    });
    if (!profile) throw new NotFoundException(`Profile ${profileId} not found`);

    const tpns = await this.tpnRepo.find({
      where: { workspaceId, tenantId: profile.tenantId },
      order: { createdAt: 'ASC' },
    });
    if (tpns.length === 0) {
      return { profileId, rows: [] };
    }

    const tpnIds = tpns.map((t) => t.id);
    const ppas = await this.ppaRepo
      .createQueryBuilder('ppa')
      .where('ppa.tenantPhoneNumberId IN (:...ids)', { ids: tpnIds })
      .andWhere('ppa.active = TRUE')
      .getMany();

    const ppaByTpn = new Map<string, ProfilePhoneAssignment[]>();
    for (const p of ppas) {
      const arr = ppaByTpn.get(p.tenantPhoneNumberId) ?? [];
      arr.push(p);
      ppaByTpn.set(p.tenantPhoneNumberId, arr);
    }

    const rows: AvailablePhoneRow[] = tpns.map((t) => {
      const linked = ppaByTpn.get(t.id) ?? [];
      const alreadyAssigned = linked.some((p) => p.profileId === profileId);
      const sharedWith = linked
        .filter((p) => p.profileId !== profileId)
        .map((p) => p.profileId);
      return {
        tenantPhoneNumberId: t.id,
        phoneNumber: t.phoneNumber,
        provider: String(t.provider),
        channel: String(t.channel),
        status: String(t.status),
        friendlyName: t.friendlyName ?? null,
        a2pStatus: t.a2pStatus ?? null,
        alreadyAssignedToThisProfile: alreadyAssigned,
        sharedWithProfileIds: sharedWith,
      };
    });

    return { profileId, rows };
  }

  async assign(workspaceId: string, dto: AssignDto): Promise<AssignedRow> {
    if (!dto.profileId) {
      throw new BadRequestException('profileId is required');
    }
    if (!dto.tenantPhoneNumberId && !dto.phoneNumber) {
      throw new BadRequestException(
        'Either tenantPhoneNumberId or phoneNumber is required',
      );
    }

    const profile = await this.profileRepo.findOne({
      where: { id: dto.profileId, workspaceId },
    });
    if (!profile) throw new NotFoundException(`Profile ${dto.profileId} not found`);

    const tpn = dto.tenantPhoneNumberId
      ? await this.tpnRepo.findOne({
          where: { id: dto.tenantPhoneNumberId, workspaceId },
        })
      : await this.tpnRepo.findOne({
          where: {
            workspaceId,
            phoneNumber: dto.phoneNumber!,
          },
        });
    if (!tpn) {
      throw new NotFoundException(
        'Phone number not allocated to this workspace. Add it via Provisioning before assigning.',
      );
    }
    // Shared-assignment amendment (PR15, 2026-05-11). The original guard
    // rejected every cross-tenant assignment — that was symmetric with the
    // strict pre-amendment Fix A in communication.service. Both guards have
    // been relaxed together: within a single workspace, a TPN owned by
    // tenant B can legitimately back-stop a profile under tenant A (e.g.
    // Yelp JAX sending from Thumbtack JAX's dedicated number while Yelp JAX
    // is in pre-A2P limbo). Cross-workspace assignment is still rejected
    // — both the lookups above already enforce workspace scope, so this
    // check is defense-in-depth and documents the invariant.
    if (tpn.workspaceId !== profile.workspaceId) {
      throw new BadRequestException(
        'Phone number and profile belong to different workspaces',
      );
    }

    return await this.dataSource.transaction(async (mgr) => {
      const ppaTxn = mgr.getRepository(ProfilePhoneAssignment);

      const existing = await ppaTxn.findOne({
        where: { profileId: profile.id, tenantPhoneNumberId: tpn.id },
      });
      if (existing) {
        if (existing.active) {
          throw new ConflictException(
            `Phone ${tpn.phoneNumber} is already assigned to this profile`,
          );
        }
        // Reactivate a soft-deactivated row instead of inserting a duplicate
        // (the (profile_id, tpn_id) unique index is partial on no condition,
        // so a stale inactive row would block a fresh insert).
        existing.active = true;
        existing.role = (dto.role as AssignmentRole) ?? AssignmentRole.PRIMARY;
        existing.priority = dto.priority ?? 100;
        existing.isDefault = await this.resolveIsDefault(
          ppaTxn,
          profile.id,
          dto.isDefault,
          existing.id,
        );
        if (existing.isDefault) {
          await this.demoteOtherDefaults(ppaTxn, profile.id, existing.id);
        }
        const saved = await ppaTxn.save(existing);
        return this.toAssignedRow(saved, tpn);
      }

      const isDefault = await this.resolveIsDefault(
        ppaTxn,
        profile.id,
        dto.isDefault,
      );
      if (isDefault) {
        await this.demoteOtherDefaults(ppaTxn, profile.id);
      }

      const created = ppaTxn.create({
        profileId: profile.id,
        tenantPhoneNumberId: tpn.id,
        role: (dto.role as AssignmentRole) ?? AssignmentRole.PRIMARY,
        isDefault,
        priority: dto.priority ?? 100,
        active: true,
      });
      const saved = await ppaTxn.save(created);
      return this.toAssignedRow(saved, tpn);
    });
  }

  /**
   * One-shot provision + assign — purchases a Twilio number for the tenant
   * (reusing the existing PhoneNumberProvisioningService) and links it to the
   * profile via profile_phone_assignments.
   *
   * The Twilio purchase is irreversible. If the post-purchase PPA insert
   * fails the TenantPhoneNumber still exists; the operator can recover by
   * linking it manually via PR15's POST /admin/phone-numbers/assign. We
   * surface that explicitly in the error message.
   */
  async provisionAndAssign(
    workspaceId: string,
    dto: ProvisionAndAssignDto,
  ): Promise<ProvisionAndAssignResult> {
    if (!dto.profileId) throw new BadRequestException('profileId is required');
    if (!dto.tenantId) throw new BadRequestException('tenantId is required');
    const provider = dto.provider ?? 'twilio';
    if (provider !== 'twilio') {
      throw new BadRequestException(
        `provider="${provider}" not supported yet — only "twilio"`,
      );
    }

    const profile = await this.profileRepo.findOne({
      where: { id: dto.profileId, workspaceId },
    });
    if (!profile) throw new NotFoundException(`Profile ${dto.profileId} not found`);
    if (profile.tenantId !== dto.tenantId) {
      throw new BadRequestException(
        'Profile does not belong to the supplied tenant',
      );
    }

    const country = dto.country ?? 'US';
    const caps = new Set(dto.capabilities ?? ['sms', 'voice']);
    const searchOpts = {
      smsCapable: caps.has('sms'),
      voiceCapable: caps.has('voice'),
      locality: dto.locality,
      region: dto.region,
    };

    const candidates = await this.provisioning.searchAvailableNumbers(
      workspaceId,
      country,
      dto.areaCode,
      searchOpts,
    );
    if (!candidates || candidates.length === 0) {
      throw new NotFoundException(
        'No available numbers match the search criteria',
      );
    }
    const picked = candidates[0];

    const purchaseResult = await this.provisioning.purchaseNumber(
      workspaceId,
      dto.tenantId,
      picked.phoneNumber,
      dto.orderedBy,
    );
    if (!purchaseResult.success || !purchaseResult.allocation) {
      throw new BadRequestException(
        `Twilio purchase failed: ${purchaseResult.error ?? 'unknown error'}`,
      );
    }
    const tpn = purchaseResult.allocation;

    let assignedRow: AssignedRow;
    try {
      assignedRow = await this.assign(workspaceId, {
        profileId: profile.id,
        tenantPhoneNumberId: tpn.id,
        role: AssignmentRole.PRIMARY,
        isDefault: dto.makeDefault,
      });
    } catch (err: any) {
      // The TPN row exists but the link to the profile didn't land. Surface a
      // clear error so the operator knows to use the assign-existing flow.
      this.logger.error(
        `[provisionAndAssign] Purchase succeeded for ${tpn.phoneNumber} (TPN ${tpn.id}) but PPA insert failed: ${err?.message}`,
      );
      throw new InternalServerErrorException(
        `Number ${tpn.phoneNumber} was purchased and saved as tenant_phone_number ${tpn.id}, but the assignment to profile ${profile.id} failed: ${err?.message}. Use POST /admin/phone-numbers/assign to retry the link.`,
      );
    }

    return {
      tenantPhoneNumber: tpn,
      profilePhoneAssignment: assignedRow,
      purchased: true,
      assigned: true,
    };
  }

  // ---------------- helpers ----------------

  private async resolveIsDefault(
    repo: Repository<ProfilePhoneAssignment>,
    profileId: string,
    requested: boolean | undefined,
    excludingPpaId?: string,
  ): Promise<boolean> {
    if (requested === true) return true;
    if (requested === false) return false;
    const qb = repo
      .createQueryBuilder('ppa')
      .where('ppa.profileId = :pid', { pid: profileId })
      .andWhere('ppa.active = TRUE')
      .andWhere('ppa.isDefault = TRUE');
    if (excludingPpaId) qb.andWhere('ppa.id <> :id', { id: excludingPpaId });
    const existingDefault = await qb.getOne();
    return !existingDefault;
  }

  private async demoteOtherDefaults(
    repo: Repository<ProfilePhoneAssignment>,
    profileId: string,
    excludingPpaId?: string,
  ): Promise<void> {
    const qb = repo
      .createQueryBuilder()
      .update(ProfilePhoneAssignment)
      .set({ isDefault: false })
      .where('profile_id = :pid', { pid: profileId })
      .andWhere('is_default = TRUE')
      .andWhere('active = TRUE');
    if (excludingPpaId) qb.andWhere('id <> :id', { id: excludingPpaId });
    await qb.execute();
  }

  private toAssignedRow(
    ppa: ProfilePhoneAssignment,
    tpn: TenantPhoneNumber,
  ): AssignedRow {
    return {
      id: ppa.id,
      profileId: ppa.profileId,
      tenantPhoneNumberId: ppa.tenantPhoneNumberId,
      phoneNumber: tpn.phoneNumber,
      provider: String(tpn.provider),
      role: String(ppa.role),
      isDefault: ppa.isDefault,
      priority: ppa.priority,
      active: ppa.active,
    };
  }
}
