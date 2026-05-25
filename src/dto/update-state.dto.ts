import { IsString, MinLength } from 'class-validator';

export class UpdateStateDto {
  @IsString()
  @MinLength(1)
  newState!: string;

  @IsString()
  @MinLength(1)
  actorId!: string;
}
