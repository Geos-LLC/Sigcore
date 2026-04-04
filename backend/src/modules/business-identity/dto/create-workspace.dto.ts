import { IsString, IsNotEmpty, IsOptional, IsEnum } from 'class-validator';
import { ProductType } from '../../../database/entities/product-workspace.entity';

export class CreateWorkspaceDto {
  @IsEnum(ProductType)
  product_type: ProductType;

  @IsString() @IsNotEmpty()
  workspace_name: string;

  @IsString() @IsNotEmpty()
  external_workspace_id: string;

  @IsOptional()
  metadata?: Record<string, unknown>;
}
