import { IsString, MinLength } from 'class-validator';

export class AgreementDto {
  @IsString()
  @MinLength(1)
  content!: string;

  @IsString()
  @MinLength(1)
  actorId!: string;
}
