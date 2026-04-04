import { IsString, IsNotEmpty, IsOptional, IsEnum } from 'class-validator';
import { AssetType } from '../../../database/entities/shared-communication-asset.entity';

export class CreateAssetDto {
  @IsEnum(AssetType)
  asset_type: AssetType;

  @IsString() @IsNotEmpty()
  value: string; // will be normalized by service (E.164 for phones, lowercase for emails)

  @IsString() @IsOptional()
  provider?: string;

  @IsString() @IsOptional()
  external_asset_id?: string;

  @IsOptional()
  metadata?: Record<string, unknown>;
}
