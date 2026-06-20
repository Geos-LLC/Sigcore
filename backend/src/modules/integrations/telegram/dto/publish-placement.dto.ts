import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class PublishPlacementDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  chatRef: string;

  @ValidateIf((o: PublishPlacementDto) => !o.imageUrl)
  @IsString()
  text?: string;

  @IsOptional()
  @IsString()
  @IsIn(['Markdown', 'HTML'])
  parseMode?: 'Markdown' | 'HTML';

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsOptional()
  @IsISO8601()
  scheduledAt?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  externalRef: string;
}

export class VerifyChatDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  chatRef: string;

  @IsOptional()
  probe?: boolean;
}

export class SubscribeDto {
  @IsOptional()
  @IsString()
  displayName?: string;
}
