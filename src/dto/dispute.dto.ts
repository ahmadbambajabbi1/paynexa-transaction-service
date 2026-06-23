import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class RaiseDisputeDto {
  @IsString()
  @MinLength(1)
  actorId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;

  @IsOptional()
  @IsString()
  parentDisputeId?: string;
}

export class DisputeResponseDto {
  @IsString()
  @MinLength(1)
  actorId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  message!: string;
}

export class ApproveReleaseDto {
  @IsString()
  @MinLength(1)
  actorId!: string;
}

export class ResolveDisputeDto {
  @IsString()
  @MinLength(1)
  adminId!: string;

  @IsIn(['RELEASE_TO_SELLER', 'REFUND_TO_BUYER'])
  resolution!: 'RELEASE_TO_SELLER' | 'REFUND_TO_BUYER';

  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  resolutionReason!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  internalNotes?: string;
}

export class DeliveryDetailsDto {
  @IsString()
  @MinLength(1)
  actorId!: string;

  @IsString()
  @MinLength(1)
  fullName!: string;

  @IsString()
  @MinLength(1)
  phone!: string;

  @IsString()
  @MinLength(1)
  email!: string;

  @IsString()
  @MinLength(1)
  addressLine1!: string;

  @IsOptional()
  @IsString()
  addressLine2?: string;

  @IsString()
  @MinLength(1)
  city!: string;

  @IsString()
  @MinLength(1)
  stateRegion!: string;

  @IsString()
  @MinLength(1)
  postalCode!: string;

  @IsString()
  @MinLength(2)
  country!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  deliveryInstructions?: string;
}
