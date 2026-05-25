import { IsString, MinLength } from 'class-validator';

export class AddDocumentDto {
  @IsString()
  @MinLength(1)
  fileUrl!: string;

  @IsString()
  @MinLength(1)
  fileKey!: string;

  @IsString()
  @MinLength(1)
  uploader!: string;

  @IsString()
  @MinLength(1)
  actorId!: string;
}
