import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Business, BusinessStatus } from '../../database/entities/business.entity';
import { ProductWorkspace, ProductType, ProductWorkspaceStatus } from '../../database/entities/product-workspace.entity';
import { SharedCommunicationAsset, AssetType, AssetStatus } from '../../database/entities/shared-communication-asset.entity';
import { WorkspaceAssetLink, LinkStatus } from '../../database/entities/workspace-asset-link.entity';

@Injectable()
export class BusinessIdentityService {
  private readonly logger = new Logger(BusinessIdentityService.name);

  constructor(
    @InjectRepository(Business) private readonly businessRepo: Repository<Business>,
    @InjectRepository(ProductWorkspace) private readonly workspaceRepo: Repository<ProductWorkspace>,
    @InjectRepository(SharedCommunicationAsset) private readonly assetRepo: Repository<SharedCommunicationAsset>,
    @InjectRepository(WorkspaceAssetLink) private readonly linkRepo: Repository<WorkspaceAssetLink>,
  ) {}

  // ═══ Normalization ═══

  normalizePhone(phone: string): string {
    if (!phone) return '';
    const digits = phone.replace(/[^\d+]/g, '');
    if (digits.startsWith('+')) return digits;
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return digits;
  }

  normalizeEmail(email: string): string {
    return (email || '').trim().toLowerCase();
  }

  normalizeValue(value: string, assetType: AssetType): string {
    if (assetType === AssetType.PHONE || assetType === AssetType.PROVIDER_NUMBER) {
      return this.normalizePhone(value);
    }
    if (assetType === AssetType.EMAIL) {
      return this.normalizeEmail(value);
    }
    return value.trim();
  }

  // ═══ Business CRUD ═══

  async createOrResolveBusiness(dto: {
    name: string;
    external_id?: string;
    legal_name?: string;
    main_phone?: string;
    main_email?: string;
    website?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ business: Business; created: boolean }> {
    // Try resolve by external_id first
    if (dto.external_id) {
      const existing = await this.businessRepo.findOne({ where: { externalId: dto.external_id } });
      if (existing) return { business: existing, created: false };
    }

    const business = new Business();
    business.name = dto.name;
    business.externalId = dto.external_id || undefined;
    business.legalName = dto.legal_name;
    business.mainPhone = dto.main_phone ? this.normalizePhone(dto.main_phone) : undefined;
    business.mainEmail = dto.main_email ? this.normalizeEmail(dto.main_email) : undefined;
    business.website = dto.website;
    business.metadata = dto.metadata;

    const saved = await this.businessRepo.save(business);
    this.logger.log(`Created business: ${saved.id} "${saved.name}"`);
    return { business: saved, created: true };
  }

  async getBusiness(id: string): Promise<Business> {
    const business = await this.businessRepo.findOne({
      where: { id },
      relations: ['workspaces'],
    });
    if (!business) throw new NotFoundException(`Business ${id} not found`);
    return business;
  }

  async listBusinesses(filters?: { name?: string; status?: string }): Promise<Business[]> {
    const qb = this.businessRepo.createQueryBuilder('b').leftJoinAndSelect('b.workspaces', 'w');
    if (filters?.name) qb.andWhere('b.name ILIKE :name', { name: `%${filters.name}%` });
    if (filters?.status) qb.andWhere('b.status = :status', { status: filters.status });
    return qb.orderBy('b.name', 'ASC').getMany();
  }

  async updateBusiness(id: string, dto: { name?: string; legal_name?: string; main_phone?: string; main_email?: string; website?: string; status?: BusinessStatus }): Promise<Business> {
    const business = await this.getBusiness(id);
    if (dto.name) business.name = dto.name;
    if (dto.legal_name !== undefined) business.legalName = dto.legal_name;
    if (dto.main_phone !== undefined) business.mainPhone = dto.main_phone;
    if (dto.main_email !== undefined) business.mainEmail = dto.main_email;
    if (dto.website !== undefined) business.website = dto.website;
    if (dto.status) business.status = dto.status;
    return this.businessRepo.save(business);
  }

  // ═══ Workspace CRUD ═══

  async registerWorkspace(businessId: string, dto: {
    product_type: ProductType;
    workspace_name: string;
    external_workspace_id: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ workspace: ProductWorkspace; created: boolean }> {
    // Idempotent by (product_type, external_workspace_id)
    const existing = await this.workspaceRepo.findOne({
      where: { productType: dto.product_type, externalWorkspaceId: dto.external_workspace_id },
    });
    if (existing) {
      // Update business_id if different (workspace being reassigned)
      if (existing.businessId !== businessId) {
        existing.businessId = businessId;
        await this.workspaceRepo.save(existing);
      }
      return { workspace: existing, created: false };
    }

    const workspace = new ProductWorkspace();
    workspace.businessId = businessId;
    workspace.productType = dto.product_type;
    workspace.workspaceName = dto.workspace_name;
    workspace.externalWorkspaceId = dto.external_workspace_id;
    workspace.metadata = dto.metadata;

    const saved = await this.workspaceRepo.save(workspace);
    this.logger.log(`Registered workspace: ${saved.id} ${saved.productType}/${saved.externalWorkspaceId} under business ${businessId}`);
    return { workspace: saved, created: true };
  }

  async getWorkspacesByBusiness(businessId: string): Promise<ProductWorkspace[]> {
    return this.workspaceRepo.find({ where: { businessId }, relations: ['assetLinks', 'assetLinks.asset'] });
  }

  async resolveWorkspaceByExternal(productType: ProductType, externalId: string): Promise<ProductWorkspace | null> {
    return this.workspaceRepo.findOne({
      where: { productType, externalWorkspaceId: externalId },
      relations: ['business'],
    });
  }

  async updateWorkspace(id: string, dto: { workspace_name?: string; status?: ProductWorkspaceStatus }): Promise<ProductWorkspace> {
    const ws = await this.workspaceRepo.findOne({ where: { id }, relations: ['business'] });
    if (!ws) throw new NotFoundException(`Workspace ${id} not found`);
    if (dto.workspace_name) ws.workspaceName = dto.workspace_name;
    if (dto.status) ws.status = dto.status;
    return this.workspaceRepo.save(ws);
  }

  // ═══ Asset CRUD ═══

  async createOrResolveAsset(dto: {
    asset_type: AssetType;
    value: string;
    provider?: string;
    external_asset_id?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ asset: SharedCommunicationAsset; created: boolean }> {
    const normalizedValue = this.normalizeValue(dto.value, dto.asset_type);
    const isGeneric = [AssetType.PHONE, AssetType.EMAIL].includes(dto.asset_type);

    // Find existing
    let existing: SharedCommunicationAsset | null = null;
    if (isGeneric) {
      // Generic: match by (type, value) regardless of provider
      existing = await this.assetRepo.findOne({
        where: { assetType: dto.asset_type, normalizedValue: normalizedValue },
      });
    } else if (dto.provider) {
      // Provider-specific: match by (type, value, provider)
      existing = await this.assetRepo.findOne({
        where: { assetType: dto.asset_type, normalizedValue: normalizedValue, provider: dto.provider },
      });
    }

    if (existing) {
      // Update external_asset_id if provided and not set
      if (dto.external_asset_id && !existing.externalAssetId) {
        existing.externalAssetId = dto.external_asset_id;
        await this.assetRepo.save(existing);
      }
      return { asset: existing, created: false };
    }

    const asset = new SharedCommunicationAsset();
    asset.assetType = dto.asset_type;
    asset.normalizedValue = normalizedValue;
    asset.displayValue = dto.value;
    asset.provider = dto.provider || undefined;
    asset.externalAssetId = dto.external_asset_id || undefined;
    asset.metadata = dto.metadata;

    const saved = await this.assetRepo.save(asset);
    this.logger.log(`Created asset: ${saved.id} ${saved.assetType}/${saved.normalizedValue} (${saved.provider || 'generic'})`);
    return { asset: saved, created: true };
  }

  async findAssets(filters: { normalized_value?: string; asset_type?: AssetType; provider?: string }): Promise<SharedCommunicationAsset[]> {
    const qb = this.assetRepo.createQueryBuilder('a');
    if (filters.normalized_value) qb.andWhere('a.normalized_value = :val', { val: filters.normalized_value });
    if (filters.asset_type) qb.andWhere('a.asset_type = :type', { type: filters.asset_type });
    if (filters.provider) qb.andWhere('a.provider = :provider', { provider: filters.provider });
    return qb.getMany();
  }

  async updateAsset(id: string, dto: { display_value?: string; status?: AssetStatus; external_asset_id?: string }): Promise<SharedCommunicationAsset> {
    const asset = await this.assetRepo.findOne({ where: { id } });
    if (!asset) throw new NotFoundException(`Asset ${id} not found`);
    if (dto.display_value !== undefined) asset.displayValue = dto.display_value;
    if (dto.status) asset.status = dto.status;
    if (dto.external_asset_id !== undefined) asset.externalAssetId = dto.external_asset_id;
    return this.assetRepo.save(asset);
  }

  // ═══ Workspace-Asset Links ═══

  async linkAssetToWorkspace(assetId: string, dto: {
    workspace_id: string;
    role: string;
    purpose?: string;
    is_primary?: boolean;
    metadata?: Record<string, unknown>;
  }): Promise<{ link: WorkspaceAssetLink; created: boolean }> {
    // Idempotent by (workspace_id, asset_id, role)
    const existing = await this.linkRepo.findOne({
      where: { workspaceId: dto.workspace_id, assetId, role: dto.role },
    });
    if (existing) {
      // Update purpose/is_primary if provided
      let changed = false;
      if (dto.purpose !== undefined && existing.purpose !== dto.purpose) { existing.purpose = dto.purpose; changed = true; }
      if (dto.is_primary !== undefined && existing.isPrimary !== dto.is_primary) { existing.isPrimary = dto.is_primary; changed = true; }
      if (changed) await this.linkRepo.save(existing);
      return { link: existing, created: false };
    }

    const link = new WorkspaceAssetLink();
    link.workspaceId = dto.workspace_id;
    link.assetId = assetId;
    link.role = dto.role;
    link.purpose = dto.purpose;
    link.isPrimary = dto.is_primary || false;
    link.metadata = dto.metadata;

    const saved = await this.linkRepo.save(link);
    this.logger.log(`Linked asset ${assetId} to workspace ${dto.workspace_id} as ${dto.role}`);
    return { link: saved, created: true };
  }

  async unlinkAsset(linkId: string): Promise<void> {
    await this.linkRepo.update(linkId, { status: LinkStatus.INACTIVE });
  }

  async getWorkspacesForAsset(assetId: string): Promise<{ asset: SharedCommunicationAsset; links: WorkspaceAssetLink[] }> {
    const asset = await this.assetRepo.findOne({ where: { id: assetId } });
    if (!asset) throw new NotFoundException(`Asset ${assetId} not found`);
    const links = await this.linkRepo.find({
      where: { assetId, status: LinkStatus.ACTIVE },
      relations: ['workspace', 'workspace.business'],
    });
    return { asset, links };
  }

  async getAssetsForWorkspace(workspaceId: string, role?: string): Promise<{ workspace: ProductWorkspace; links: WorkspaceAssetLink[] }> {
    const workspace = await this.workspaceRepo.findOne({ where: { id: workspaceId } });
    if (!workspace) throw new NotFoundException(`Workspace ${workspaceId} not found`);
    const where: any = { workspaceId, status: LinkStatus.ACTIVE };
    if (role) where.role = role;
    const links = await this.linkRepo.find({ where, relations: ['asset'] });
    return { workspace, links };
  }
}
