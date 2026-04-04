import { IsString, IsOptional, IsEnum } from 'class-validator';
import { AssetType } from '../../../database/entities/shared-communication-asset.entity';

export class ResolveIdentityDto {
  @IsEnum(AssetType)
  asset_type: AssetType;

  @IsString()
  normalized_value: string;

  @IsString() @IsOptional()
  provider?: string;

  @IsString() @IsOptional()
  external_asset_id?: string;
}
