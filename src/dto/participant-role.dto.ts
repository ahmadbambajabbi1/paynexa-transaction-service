import { IsString, MinLength } from 'class-validator';

export class ParticipantRoleDto {
  @IsString()
  @MinLength(1)
  actorId!: string;

  @IsString()
  @MinLength(1)
  role!: string;

  @IsString()
  @MinLength(1)
  partySide!: string;
}
