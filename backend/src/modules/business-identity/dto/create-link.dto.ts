import { IsString, IsNotEmpty, IsOptional, IsBoolean, IsUUID } from 'class-validator';

export class CreateLinkDto {
  @IsUUID()
  workspace_id: string;

  @IsString() @IsNotEmpty()
  role: string;

  @IsString() @IsOptional()
  purpose?: string;

  @IsBoolean() @IsOptional()
  is_primary?: boolean;

  @IsOptional()
  metadata?: Record<string, unknown>;
}
