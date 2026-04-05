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
  productType: string; // resolved from externalId/name pattern
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

  /**
   * Detect which app a tenant belongs to based on externalId and name patterns.
   */
  private detectProductType(tenant: Tenant): string {
    const ext = tenant.externalId || '';
    const name = (tenant.name || '').toLowerCase();

    // ServiceFlow: numeric external IDs (user.id)
    if (/^\d+$/.test(ext) || name.includes('serviceflow')) return 'serviceflow';

    // Callio app tenant
    if (ext.startsWith('callio-') || name === 'callio') return 'callio';

    // LeadBridge app tenant
    if (ext.startsWith('leadbridge-') || name === 'leadbridge') return 'leadbridge';

    // UUID external IDs are typically LeadBridge business tenants (LB user IDs are UUIDs)
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ext)) return 'leadbridge';

    // Fallback
    return 'sigcore';
  }

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
        productType: this.detectProductType(tenant),
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
  //
  // IMPORTANT: Backfill does NOT merge tenants across apps or within the same app.
  // Each tenant becomes its own business + product_workspace.
  //
  // Cross-app linking (e.g., "SF workspace X and LB workspace Y belong to the same business")
  // happens later when each app registers itself and explicitly declares its business_id.
  // Name/phone/email matches are noted in metadata for future suggested linking, but never
  // auto-merge at the backfill stage.

  private groupCandidates(candidates: BackfillCandidate[]): BackfillCandidate[][] {
    // Each tenant = its own group. No merging.
    return candidates.map((c) => [c]);
  }

  // ═══ Confidence scoring ═══

  private scoreGroup(group: BackfillCandidate[]): {
    confidence: number;
    matchingKeys: string[];
    needsReview: boolean;
    reviewReason?: string;
  } {
    // Each group is always a single tenant (no merging).
    // Confidence is always 100 — each tenant gets its own business.
    return { confidence: 100, matchingKeys: ['single_tenant'], needsReview: false };
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
            product_type: member.productType as ProductType,
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

  // ═══ Reset ═══

  async reset(): Promise<{ cleared_tenants: number; deleted_links: number; deleted_workspaces: number; deleted_assets: number; deleted_businesses: number }> {
    // 1. Clear tenant refs
    const tenants = await this.tenantRepo.find();
    let clearedTenants = 0;
    for (const t of tenants) {
      if (t.businessIdentityId || t.productWorkspaceId) {
        t.businessIdentityId = undefined;
        t.productWorkspaceId = undefined;
        await this.tenantRepo.save(t);
        clearedTenants++;
      }
    }

    // 2. Delete links, workspaces, assets, businesses (in order)
    const { affected: links } = await this.tenantRepo.manager.getRepository('WorkspaceAssetLink').delete({});
    const { affected: workspaces } = await this.productWsRepo.delete({});
    const { affected: assets } = await this.tenantRepo.manager.getRepository('SharedCommunicationAsset').delete({});
    const { affected: businesses } = await this.businessRepo.delete({});

    this.logger.log(`[Reset] Cleared ${clearedTenants} tenants, deleted ${links} links, ${workspaces} workspaces, ${assets} assets, ${businesses} businesses`);
    return { cleared_tenants: clearedTenants, deleted_links: links || 0, deleted_workspaces: workspaces || 0, deleted_assets: assets || 0, deleted_businesses: businesses || 0 };
  }

  // ═══ Cross-app link suggestions (read-only) ═══

  /**
   * Suggest which existing businesses/workspaces might belong to the same real-world company.
   * Based on name/phone/email similarity across DIFFERENT product_workspaces.
   * Does NOT modify any records — returns suggestions for manual review.
   */
  async suggestCrossAppLinks(): Promise<{
    suggestions: Array<{
      business_a: { id: string; name: string; product_type: string };
      business_b: { id: string; name: string; product_type: string };
      matching_keys: string[];
      confidence: number;
    }>;
  }> {
    // Get all product workspaces with their businesses and linked assets
    const workspaces = await this.productWsRepo.find({
      relations: ['business', 'assetLinks', 'assetLinks.asset'],
    });

    const suggestions: Array<{
      business_a: { id: string; name: string; product_type: string };
      business_b: { id: string; name: string; product_type: string };
      matching_keys: string[];
      confidence: number;
    }> = [];

    // Compare each pair of workspaces from DIFFERENT products
    for (let i = 0; i < workspaces.length; i++) {
      for (let j = i + 1; j < workspaces.length; j++) {
        const a = workspaces[i];
        const b = workspaces[j];

        // Skip if same product type (within-app matching is not our concern)
        if (a.productType === b.productType) continue;
        // Skip if already same business
        if (a.businessId === b.businessId) continue;

        const matchingKeys: string[] = [];
        let confidence = 0;

        // Name similarity
        const nameA = this.normalizeName(a.business?.name || a.workspaceName);
        const nameB = this.normalizeName(b.business?.name || b.workspaceName);
        if (nameA && nameB && nameA === nameB) {
          confidence += 40;
          matchingKeys.push(`name: "${a.business?.name || a.workspaceName}"`);
        }

        // Shared phone assets
        const phonesA = (a.assetLinks || []).filter(l => l.asset?.assetType === 'phone').map(l => l.asset.normalizedValue);
        const phonesB = (b.assetLinks || []).filter(l => l.asset?.assetType === 'phone').map(l => l.asset.normalizedValue);
        const sharedPhones = phonesA.filter(p => phonesB.includes(p));
        if (sharedPhones.length > 0) {
          confidence += 30;
          matchingKeys.push(`phone: ${sharedPhones.join(', ')}`);
        }

        // Shared email assets
        const emailsA = (a.assetLinks || []).filter(l => l.asset?.assetType === 'email').map(l => l.asset.normalizedValue);
        const emailsB = (b.assetLinks || []).filter(l => l.asset?.assetType === 'email').map(l => l.asset.normalizedValue);
        const sharedEmails = emailsA.filter(e => emailsB.includes(e));
        if (sharedEmails.length > 0) {
          confidence += 20;
          matchingKeys.push(`email: ${sharedEmails.join(', ')}`);
        }

        if (confidence > 0) {
          suggestions.push({
            business_a: { id: a.businessId, name: a.business?.name || a.workspaceName, product_type: a.productType },
            business_b: { id: b.businessId, name: b.business?.name || b.workspaceName, product_type: b.productType },
            matching_keys: matchingKeys,
            confidence,
          });
        }
      }
    }

    suggestions.sort((a, b) => b.confidence - a.confidence);
    return { suggestions };
  }
}
