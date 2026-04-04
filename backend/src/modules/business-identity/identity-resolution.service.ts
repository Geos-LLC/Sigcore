import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SharedCommunicationAsset, AssetType } from '../../database/entities/shared-communication-asset.entity';
import { WorkspaceAssetLink, LinkStatus } from '../../database/entities/workspace-asset-link.entity';
import { ProductWorkspace, ProductWorkspaceStatus } from '../../database/entities/product-workspace.entity';
import { BusinessIdentityService } from './business-identity.service';

export interface CandidateWorkspace {
  workspace: {
    id: string;
    productType: string;
    workspaceName: string;
    externalWorkspaceId: string;
    businessId: string;
  };
  business: {
    id: string;
    name: string;
  };
  link: {
    id: string;
    role: string;
    purpose?: string;
    isPrimary: boolean;
  };
  asset: {
    id: string;
    assetType: string;
    normalizedValue: string;
    provider?: string;
    externalAssetId?: string;
  };
}

/**
 * Step 1 of two-step resolution: Asset → list ALL candidate workspaces.
 * This service performs identity resolution only — no scoring or selection.
 */
@Injectable()
export class IdentityResolutionService {
  private readonly logger = new Logger(IdentityResolutionService.name);

  constructor(
    @InjectRepository(SharedCommunicationAsset) private readonly assetRepo: Repository<SharedCommunicationAsset>,
    @InjectRepository(WorkspaceAssetLink) private readonly linkRepo: Repository<WorkspaceAssetLink>,
    private readonly biService: BusinessIdentityService,
  ) {}

  async resolve(input: {
    asset_type: AssetType;
    normalized_value: string;
    provider?: string;
    external_asset_id?: string;
  }): Promise<{ asset: SharedCommunicationAsset | null; candidates: CandidateWorkspace[] }> {
    const normalizedValue = this.biService.normalizeValue(input.normalized_value, input.asset_type);

    // Step 1: Find the asset
    let asset: SharedCommunicationAsset | null = null;

    // Try exact match by external_asset_id + provider first (most specific)
    if (input.external_asset_id && input.provider) {
      asset = await this.assetRepo.findOne({
        where: { externalAssetId: input.external_asset_id, provider: input.provider },
      });
    }

    // Fallback: match by normalized_value + asset_type
    if (!asset) {
      const isGeneric = [AssetType.PHONE, AssetType.EMAIL].includes(input.asset_type);
      if (isGeneric) {
        asset = await this.assetRepo.findOne({
          where: { assetType: input.asset_type, normalizedValue: normalizedValue },
        });
      } else if (input.provider) {
        asset = await this.assetRepo.findOne({
          where: { assetType: input.asset_type, normalizedValue: normalizedValue, provider: input.provider },
        });
      } else {
        // Try without provider
        asset = await this.assetRepo.findOne({
          where: { assetType: input.asset_type, normalizedValue: normalizedValue },
        });
      }
    }

    if (!asset) {
      this.logger.debug(`No asset found for ${input.asset_type}/${normalizedValue} (${input.provider || 'any'})`);
      return { asset: null, candidates: [] };
    }

    // Step 2: Find all workspace links for this asset
    const links = await this.linkRepo
      .createQueryBuilder('link')
      .leftJoinAndSelect('link.workspace', 'workspace')
      .leftJoinAndSelect('workspace.business', 'business')
      .where('link.asset_id = :assetId', { assetId: asset.id })
      .andWhere('link.status = :linkStatus', { linkStatus: LinkStatus.ACTIVE })
      .andWhere('workspace.status = :wsStatus', { wsStatus: ProductWorkspaceStatus.ACTIVE })
      .getMany();

    const candidates: CandidateWorkspace[] = links.map((link) => ({
      workspace: {
        id: link.workspace.id,
        productType: link.workspace.productType,
        workspaceName: link.workspace.workspaceName,
        externalWorkspaceId: link.workspace.externalWorkspaceId,
        businessId: link.workspace.businessId,
      },
      business: {
        id: link.workspace.business?.id || link.workspace.businessId,
        name: link.workspace.business?.name || '',
      },
      link: {
        id: link.id,
        role: link.role,
        purpose: link.purpose,
        isPrimary: link.isPrimary,
      },
      asset: {
        id: asset.id,
        assetType: asset.assetType,
        normalizedValue: asset.normalizedValue,
        provider: asset.provider,
        externalAssetId: asset.externalAssetId,
      },
    }));

    this.logger.log(`Resolved ${candidates.length} candidates for asset ${asset.id} (${asset.assetType}/${asset.normalizedValue})`);
    return { asset, candidates };
  }
}
