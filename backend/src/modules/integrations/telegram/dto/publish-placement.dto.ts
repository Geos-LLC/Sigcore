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

// ===== Account-mode DTOs =====

export class StartAccountLinkDto {
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  phoneNumber: string;

  @IsOptional()
  @IsString()
  password?: string;

  // Truthy required — controller / service rejects when not strictly true.
  riskAcknowledged: boolean;
}

export class AccountCodeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(16)
  code: string;
}

export class AccountPasswordDto {
  @IsString()
  @MinLength(1)
  password: string;
}
