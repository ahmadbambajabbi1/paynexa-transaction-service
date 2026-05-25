import { IsString, MinLength } from 'class-validator';

export class ActorDto {
  @IsString()
  @MinLength(1)
  actorId!: string;
}
