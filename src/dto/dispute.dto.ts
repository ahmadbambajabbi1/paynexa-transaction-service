import { IsString, MinLength } from 'class-validator';

export class DisputeDto {
  @IsString()
  @MinLength(1)
  actorId!: string;

  @IsString()
  @MinLength(1)
  reason!: string;
}
