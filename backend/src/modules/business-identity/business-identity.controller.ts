import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { SigcoreAuthGuard } from '../auth/sigcore-auth.guard';
import { BusinessIdentityService } from './business-identity.service';
import { BackfillService } from './backfill.service';
import { IdentityResolutionService } from './identity-resolution.service';
import { RoutingSelectionService } from './routing-selection.service';
import { CreateBusinessDto } from './dto/create-business.dto';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { CreateAssetDto } from './dto/create-asset.dto';
import { CreateLinkDto } from './dto/create-link.dto';
import { ResolveIdentityDto } from './dto/resolve-identity.dto';
import { SelectRoutingDto } from './dto/select-routing.dto';
import { ProductType } from '../../database/entities/product-workspace.entity';
import { AssetType } from '../../database/entities/shared-communication-asset.entity';

@Controller('v1')
@UseGuards(SigcoreAuthGuard)
export class BusinessIdentityController {
  constructor(
    private readonly biService: BusinessIdentityService,
    private readonly identityService: IdentityResolutionService,
    private readonly routingService: RoutingSelectionService,
    private readonly backfillService: BackfillService,
  ) {}

  // ═══ Business CRUD ═══

  @Post('businesses')
  async createBusiness(@Body() dto: CreateBusinessDto) {
    const { business, created } = await this.biService.createOrResolveBusiness(dto);
    return { data: { ...business, created } };
  }

  @Get('businesses/:id')
  async getBusiness(@Param('id') id: string) {
    const business = await this.biService.getBusiness(id);
    return { data: business };
  }

  @Get('businesses')
  async listBusinesses(
    @Query('name') name?: string,
    @Query('status') status?: string,
  ) {
    const businesses = await this.biService.listBusinesses({ name, status });
    return { data: businesses };
  }

  @Patch('businesses/:id')
  async updateBusiness(@Param('id') id: string, @Body() dto: any) {
    const business = await this.biService.updateBusiness(id, dto);
    return { data: business };
  }

  // ═══ Workspace CRUD ═══

  @Post('businesses/:id/workspaces')
  async registerWorkspace(@Param('id') businessId: string, @Body() dto: CreateWorkspaceDto) {
    const { workspace, created } = await this.biService.registerWorkspace(businessId, dto);
    return { data: { ...workspace, created } };
  }

  @Get('businesses/:id/workspaces')
  async getWorkspacesByBusiness(@Param('id') businessId: string) {
    const workspaces = await this.biService.getWorkspacesByBusiness(businessId);
    return { data: workspaces };
  }

  @Get('workspaces/by-external')
  async resolveWorkspace(
    @Query('product_type') productType: ProductType,
    @Query('external_id') externalId: string,
  ) {
    const workspace = await this.biService.resolveWorkspaceByExternal(productType, externalId);
    if (!workspace) return { data: null };
    return { data: workspace };
  }

  @Patch('workspaces/:id')
  async updateWorkspace(@Param('id') id: string, @Body() dto: any) {
    const workspace = await this.biService.updateWorkspace(id, dto);
    return { data: workspace };
  }

  // ═══ Asset CRUD ═══

  @Post('assets')
  async createAsset(@Body() dto: CreateAssetDto) {
    const { asset, created } = await this.biService.createOrResolveAsset(dto);
    return { data: { ...asset, created } };
  }

  @Get('assets')
  async findAssets(
    @Query('normalized_value') normalizedValue?: string,
    @Query('asset_type') assetType?: AssetType,
    @Query('provider') provider?: string,
  ) {
    const assets = await this.biService.findAssets({
      normalized_value: normalizedValue,
      asset_type: assetType,
      provider,
    });
    return { data: assets };
  }

  @Patch('assets/:id')
  async updateAsset(@Param('id') id: string, @Body() dto: any) {
    const asset = await this.biService.updateAsset(id, dto);
    return { data: asset };
  }

  // ═══ Asset-Workspace Links ═══

  @Post('assets/:id/links')
  async linkAsset(@Param('id') assetId: string, @Body() dto: CreateLinkDto) {
    const { link, created } = await this.biService.linkAssetToWorkspace(assetId, dto);
    return { data: { ...link, created } };
  }

  @Delete('workspace-asset-links/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unlinkAsset(@Param('id') linkId: string) {
    await this.biService.unlinkAsset(linkId);
  }

  @Get('assets/:id/workspaces')
  async getWorkspacesForAsset(@Param('id') assetId: string) {
    const result = await this.biService.getWorkspacesForAsset(assetId);
    return { data: result };
  }

  @Get('workspaces/:id/assets')
  async getAssetsForWorkspace(
    @Param('id') workspaceId: string,
    @Query('role') role?: string,
  ) {
    const result = await this.biService.getAssetsForWorkspace(workspaceId, role);
    return { data: result };
  }

  // ═══ Two-Step Resolution ═══

  @Post('identity/resolve')
  @HttpCode(HttpStatus.OK)
  async resolveIdentity(@Body() dto: ResolveIdentityDto) {
    const result = await this.identityService.resolve(dto);
    return { data: result };
  }

  @Post('routing/select')
  @HttpCode(HttpStatus.OK)
  async selectRouting(@Body() dto: SelectRoutingDto) {
    const result = this.routingService.select(dto.candidates, dto.context);
    return { data: result };
  }

  // ═══ Admin / Backfill ═══

  @Get('admin/backfill/preview')
  async backfillPreview() {
    const preview = await this.backfillService.preview();
    return { data: preview };
  }

  @Post('admin/backfill/run')
  @HttpCode(HttpStatus.OK)
  async backfillRun(@Body() dto: { dry_run?: boolean; confidence_threshold?: number; include_review?: boolean }) {
    const result = await this.backfillService.run({
      dry_run: dto.dry_run,
      confidence_threshold: dto.confidence_threshold,
      include_review: dto.include_review,
    });
    return { data: result };
  }

  @Post('admin/backfill/reset')
  @HttpCode(HttpStatus.OK)
  async backfillReset() {
    const result = await this.backfillService.reset();
    return { data: result };
  }

  /**
   * Suggest cross-app business links based on name/phone/email similarity.
   * Read-only — does NOT create or modify any records.
   * Returns suggested groupings that an admin can review and apply manually
   * via the businesses/workspaces CRUD endpoints.
   */
  @Get('admin/suggest-links')
  async suggestLinks() {
    const suggestions = await this.backfillService.suggestCrossAppLinks();
    return { data: suggestions };
  }
}
