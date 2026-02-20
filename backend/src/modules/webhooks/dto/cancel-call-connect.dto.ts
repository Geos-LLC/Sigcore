import { IsString } from 'class-validator';

export class CancelCallConnectDto {
  @IsString()
  sessionId: string;
}
