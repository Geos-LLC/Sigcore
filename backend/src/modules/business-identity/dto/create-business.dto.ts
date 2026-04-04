import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class CreateBusinessDto {
  @IsString() @IsNotEmpty()
  name: string;

  @IsString() @IsOptional()
  external_id?: string;

  @IsString() @IsOptional()
  legal_name?: string;

  @IsString() @IsOptional()
  main_phone?: string;

  @IsString() @IsOptional()
  main_email?: string;

  @IsString() @IsOptional()
  website?: string;

  @IsOptional()
  metadata?: Record<string, unknown>;
}
