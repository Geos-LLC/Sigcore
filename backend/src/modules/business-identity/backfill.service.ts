import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Tenant } from '../../database/entities/tenant.entity';
import { TenantPhoneNumber } from '../../database/entities/tenant-phone-number.entity';
import { Workspace } from '../../database/entities/workspace.entity';
import { Business } from '../../database/entities/business.entity';
import { ProductWorkspace, ProductType } from '../../database/entities/product-workspace.entity';
import { AssetType } from '../../database/entities/shared-communication-asset.entity';
import { BusinessIdentityService } from './business-identity.service';

// ═══ Types ═══

export interface BackfillCandidate {
  tenantId: string;
  workspaceId: string;
  name: string;
  normalizedName: string;
  phones: string[];
  externalId: string;
  provider?: string;
}

export interface ProposedGroup {
  businessName: string;
  confidence: number;
  matchingKeys: string[];
  members: BackfillCandidate[];
  needsReview: boolean;
  reviewReason?: string;
}

export interface BackfillPreview {
  proposed_groups: ProposedGroup[];
  stats: {
    total_tenants: number;
    total_groups: number;
    auto_apply: number;
    needs_review: number;
    skip: number;
    already_registered: number;
  };
}

export interface BackfillResult {
  created_businesses: number;
  created_workspaces: number;
  created_assets: number;
  created_links: number;
  skipped_existing: number;
  skipped_below_threshold: number;
  flagged_for_review: number;
  errors: string[];
}

@Injectable()
export class BackfillService {
  private readonly logger = new Logger(BackfillService.name);

  constructor(
    @InjectRepository(Tenant) private readonly tenantRepo: Repository<Tenant>,
    @InjectRepository(TenantPhoneNumber) private readonly tpnRepo: Repository<TenantPhoneNumber>,
    @InjectRepository(Workspace) private readonly workspaceRepo: Repository<Workspace>,
    @InjectRepository(Business) private readonly businessRepo: Repository<Business>,
    @InjectRepository(ProductWorkspace) private readonly productWsRepo: Repository<ProductWorkspace>,
    private readonly biService: BusinessIdentityService,
  ) {}

  // ═══ Name normalization ═══

  private normalizeName(name: string): string {
    return (name || '')
      .toLowerCase()
      .replace(/\b(llc|inc|corp|co|ltd|company|group|services|cleaning)\b/gi, '')
      .replace(/[^a-z0-9]/g, '')
      .trim();
  }

  // ═══ Preview ═══

  async preview(): Promise<BackfillPreview> {
    // 1. Load all tenants with their phone numbers
    const tenants = await this.tenantRepo.find({ relations: ['phoneNumbers'] });
    const candidates: BackfillCandidate[] = [];

    // Check which tenants are already registered
    let alreadyRegistered = 0;

    for (const tenant of tenants) {
      if (tenant.productWorkspaceId) {
        alreadyRegistered++;
        continue; // Already has a product workspace — skip
      }

      const phones = (tenant.phoneNumbers || [])
        .map((pn) => this.biService.normalizePhone(pn.phoneNumber))
        .filter(Boolean);

      candidates.push({
        tenantId: tenant.id,
        workspaceId: tenant.workspaceId,
        name: tenant.name,
        normalizedName: this.normalizeName(tenant.name),
        phones,
        externalId: tenant.externalId,
      });
    }

    // 2. Group candidates by matching keys
    const groups = this.groupCandidates(candidates);

    // 3. Score each group
    const proposedGroups: ProposedGroup[] = groups.map((group) => {
      const { confidence, matchingKeys, needsReview, reviewReason } = this.scoreGroup(group);
      return {
        businessName: this.pickBestName(group),
        confidence,
        matchingKeys,
        members: group,
        needsReview,
        reviewReason,
      };
    });

    // 4. Stats
    const autoApply = proposedGroups.filter((g) => g.confidence >= 80).length;
    const needsReview = proposedGroups.filter((g) => g.confidence >= 40 && g.confidence < 80).length;
    const skip = proposedGroups.filter((g) => g.confidence < 40).length;

    return {
      proposed_groups: proposedGroups,
      stats: {
        total_tenants: tenants.length,
        total_groups: proposedGroups.length,
        auto_apply: autoApply,
        needs_review: needsReview,
        skip,
        already_registered: alreadyRegistered,
      },
    };
  }

  // ═══ Grouping algorithm ═══

  private groupCandidates(candidates: BackfillCandidate[]): BackfillCandidate[][] {
    // Union-Find approach: group candidates that share matching keys
    const parent: Map<number, number> = new Map();
    const find = (i: number): number => {
      if (!parent.has(i)) parent.set(i, i);
      if (parent.get(i) !== i) parent.set(i, find(parent.get(i)!));
      return parent.get(i)!;
    };
    const union = (i: number, j: number) => {
      parent.set(find(i), find(j));
    };

    for (let i = 0; i < candidates.length; i++) {
      parent.set(i, i);
    }

    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        if (this.shouldGroup(candidates[i], candidates[j])) {
          union(i, j);
        }
      }
    }

    // Collect groups
    const groupMap = new Map<number, BackfillCandidate[]>();
    for (let i = 0; i < candidates.length; i++) {
      const root = find(i);
      if (!groupMap.has(root)) groupMap.set(root, []);
      groupMap.get(root)!.push(candidates[i]);
    }

    return Array.from(groupMap.values());
  }

  private shouldGroup(a: BackfillCandidate, b: BackfillCandidate): boolean {
    // Same normalized name (strong signal)
    if (a.normalizedName && b.normalizedName && a.normalizedName === b.normalizedName) return true;

    // Shared phone number (strong signal)
    const sharedPhones = a.phones.filter((p) => b.phones.includes(p));
    if (sharedPhones.length > 0) return true;

    // NOTE: Same workspace ID is NOT a grouping signal.
    // Multi-tenant workspaces have many unrelated tenants sharing one workspaceId.

    return false;
  }

  // ═══ Confidence scoring ═══

  private scoreGroup(group: BackfillCandidate[]): {
    confidence: number;
    matchingKeys: string[];
    needsReview: boolean;
    reviewReason?: string;
  } {
    if (group.length === 1) {
      // Single tenant — auto-create as its own business
      return { confidence: 100, matchingKeys: ['single_tenant'], needsReview: false };
    }

    let confidence = 0;
    const matchingKeys: string[] = [];

    // Check name match
    const names = new Set(group.map((c) => c.normalizedName).filter(Boolean));
    if (names.size === 1) {
      confidence += 40;
      matchingKeys.push(`name_match: "${group[0].name}"`);
    }

    // Check phone overlap
    const allPhones = group.flatMap((c) => c.phones);
    const phoneSet = new Set(allPhones);
    if (phoneSet.size < allPhones.length) {
      // At least one shared phone
      confidence += 30;
      const shared = allPhones.filter((p, i) => allPhones.indexOf(p) !== i);
      matchingKeys.push(`phone_match: ${[...new Set(shared)].join(', ')}`);
    }

    // NOTE: same workspace is NOT scored — multi-tenant workspaces are common

    // Ambiguity checks
    let needsReview = false;
    let reviewReason: string | undefined;

    // If only one weak signal
    if (confidence < 40) {
      needsReview = false; // Will be skipped entirely
    } else if (confidence < 80) {
      needsReview = true;
      reviewReason = `Partial match (confidence ${confidence}): ${matchingKeys.join('; ')}`;
    }

    // If names don't match but phones do — suspicious
    if (names.size > 1 && matchingKeys.some((k) => k.startsWith('phone_match'))) {
      needsReview = true;
      reviewReason = `Different names but shared phone: ${[...names].join(', ')}`;
    }

    return { confidence, matchingKeys, needsReview, reviewReason };
  }

  private pickBestName(group: BackfillCandidate[]): string {
    // Pick the longest name (usually the most complete)
    return group.reduce((best, c) => (c.name.length > best.length ? c.name : best), group[0].name);
  }

  // ═══ Run backfill ═══

  async run(options: {
    dry_run?: boolean;
    confidence_threshold?: number;
    include_review?: boolean;
  }): Promise<BackfillResult> {
    const dryRun = options.dry_run !== false; // Default true
    const threshold = options.confidence_threshold ?? 80;
    const includeReview = options.include_review ?? false;

    const preview = await this.preview();
    const result: BackfillResult = {
      created_businesses: 0,
      created_workspaces: 0,
      created_assets: 0,
      created_links: 0,
      skipped_existing: preview.stats.already_registered,
      skipped_below_threshold: 0,
      flagged_for_review: 0,
      errors: [],
    };

    for (const group of preview.proposed_groups) {
      // Skip below threshold
      if (group.confidence < threshold) {
        if (group.confidence >= 40) {
          result.flagged_for_review++;
        } else {
          result.skipped_below_threshold++;
        }
        continue;
      }

      // Skip review-needed unless explicitly included
      if (group.needsReview && !includeReview) {
        result.flagged_for_review++;
        continue;
      }

      if (dryRun) {
        result.created_businesses++;
        result.created_workspaces += group.members.length;
        // Count unique phones
        const uniquePhones = new Set(group.members.flatMap((m) => m.phones));
        result.created_assets += uniquePhones.size;
        result.created_links += uniquePhones.size * group.members.length;
        continue;
      }

      // Apply
      try {
        // 1. Create business
        const externalId = `sigcore-backfill-${group.members[0].tenantId}`;
        const { business, created: bizCreated } = await this.biService.createOrResolveBusiness({
          name: group.businessName,
          external_id: externalId,
          metadata: {
            backfill_run: new Date().toISOString(),
            source: 'auto',
            confidence: group.confidence,
            matching_keys: group.matchingKeys,
          },
        });
        if (bizCreated) result.created_businesses++;

        // 2. Create product workspaces for each member
        for (const member of group.members) {
          const { workspace, created: wsCreated } = await this.biService.registerWorkspace(business.id, {
            product_type: ProductType.SIGCORE,
            workspace_name: member.name,
            external_workspace_id: member.tenantId,
            metadata: { sigcore_workspace_id: member.workspaceId },
          });
          if (wsCreated) result.created_workspaces++;

          // Update tenant record
          await this.tenantRepo.update(member.tenantId, {
            businessIdentityId: business.id,
            productWorkspaceId: workspace.id,
          });

          // 3. Create assets + links for phone numbers
          for (const phone of member.phones) {
            const { asset, created: assetCreated } = await this.biService.createOrResolveAsset({
              asset_type: AssetType.PHONE,
              value: phone,
            });
            if (assetCreated) result.created_assets++;

            const { created: linkCreated } = await this.biService.linkAssetToWorkspace(asset.id, {
              workspace_id: workspace.id,
              role: 'sigcore_registered_number',
              purpose: 'general_inbox',
              is_primary: member.phones.indexOf(phone) === 0,
            });
            if (linkCreated) result.created_links++;
          }
        }
      } catch (e) {
        result.errors.push(`Group "${group.businessName}": ${e.message}`);
        this.logger.error(`Backfill error for group "${group.businessName}": ${e.message}`);
      }
    }

    this.logger.log(
      `Backfill ${dryRun ? '(dry run) ' : ''}complete: ` +
        `${result.created_businesses} businesses, ${result.created_workspaces} workspaces, ` +
        `${result.created_assets} assets, ${result.created_links} links, ` +
        `${result.flagged_for_review} flagged, ${result.errors.length} errors`,
    );

    return result;
  }
}
