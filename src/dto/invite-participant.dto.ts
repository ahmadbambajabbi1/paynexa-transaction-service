import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class InviteParticipantDto {
  @IsString()
  @MinLength(1)
  actorId!: string;

  @IsString()
  @MinLength(1)
  participantUserId!: string;

  @IsString()
  @MinLength(1)
  role!: string;

  /** Which party is inviting: must match actorId (buyer or seller). */
  @IsString()
  @MinLength(1)
  partySide!: string;

  /** Optional custom note; if omitted the server uses a default template. */
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  message?: string;
}
