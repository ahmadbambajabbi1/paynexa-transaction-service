import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class TransactionDocumentInputDto {
  @IsString()
  @MinLength(1)
  fileUrl!: string;

  @IsString()
  @MinLength(1)
  fileKey!: string;

  @IsString()
  @MinLength(1)
  uploader!: string;
}

/**
 * Escrow / two-party transaction creation. The creator is always the seller and
 * the counterparty is always the buyer; legacy role/fundedBy fields are accepted
 * but ignored so old clients keep working while the workflow stays automatic.
 */
export class CreateTransactionDto {
  @IsString()
  @MinLength(1)
  createdByUserId!: string;

  @IsString()
  @MinLength(1)
  counterpartyId!: string;

  @IsOptional()
  @IsString()
  role?: string;

  @IsString()
  @MinLength(1)
  productId!: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsString()
  fundedBy?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TransactionDocumentInputDto)
  documents?: TransactionDocumentInputDto[];
}

export class CreatePublicTransactionDto {
  @IsString()
  @MinLength(1)
  createdByUserId!: string;

  @IsString()
  @MinLength(1)
  itemTitle!: string;

  @IsOptional()
  @IsString()
  itemDescription?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity!: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  unitPrice!: number;

  @IsOptional()
  @IsBoolean()
  deliveryNeeded?: boolean;

  @IsOptional()
  @IsString()
  sellerNote?: string;

  @IsOptional()
  @IsString()
  type?: string;
}
