import { IsString, IsNotEmpty, IsOptional, IsObject } from 'class-validator';

export class SendMessageDto {
  @IsString()
  @IsNotEmpty()
  body: string;

  @IsString()
  @IsOptional()
  fromNumber?: string;

  @IsObject()
  @IsOptional()
  metadata?: Record<string, unknown>;
}
