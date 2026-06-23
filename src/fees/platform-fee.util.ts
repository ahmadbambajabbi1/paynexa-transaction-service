import { PlatformFeeType, Prisma } from '@prisma/client';

export type FeeConfigInput = {
  percentageEnabled: boolean;
  percentageFee: string | number;
  fixedEnabled: boolean;
  fixedFee: string | number;
};

export type FeeBreakdown = {
  feeType: PlatformFeeType;
  platformFeeAmount: string;
  sellerNetAmount: string;
  platformFeePercent: string | null;
  platformFeeFixed: string | null;
};

export function calculatePlatformFee(
  amountRaw: string | number,
  config: FeeConfigInput,
): FeeBreakdown {
  const amount = new Prisma.Decimal(String(amountRaw));
  let pctPart = new Prisma.Decimal(0);
  let fixedPart = new Prisma.Decimal(0);

  if (config.percentageEnabled) {
    const pct = new Prisma.Decimal(String(config.percentageFee || '0'));
    pctPart = amount.mul(pct).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  }
  if (config.fixedEnabled) {
    fixedPart = new Prisma.Decimal(String(config.fixedFee || '0')).toDecimalPlaces(
      2,
      Prisma.Decimal.ROUND_HALF_UP,
    );
  }

  const platformFee = pctPart.add(fixedPart).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  const sellerNet = Prisma.Decimal.max(amount.sub(platformFee), new Prisma.Decimal(0)).toDecimalPlaces(
    2,
    Prisma.Decimal.ROUND_HALF_UP,
  );

  let feeType: PlatformFeeType = PlatformFeeType.NONE;
  if (config.percentageEnabled && config.fixedEnabled) {
    feeType = PlatformFeeType.COMBINED;
  } else if (config.percentageEnabled) {
    feeType = PlatformFeeType.PERCENTAGE;
  } else if (config.fixedEnabled) {
    feeType = PlatformFeeType.FIXED;
  }

  return {
    feeType,
    platformFeeAmount: platformFee.toString(),
    sellerNetAmount: sellerNet.toString(),
    platformFeePercent: config.percentageEnabled ? pctPart.toString() : null,
    platformFeeFixed: config.fixedEnabled ? fixedPart.toString() : null,
  };
}

export function formatFeeTypeLabel(feeType: PlatformFeeType | null | undefined): string {
  switch (feeType) {
    case PlatformFeeType.PERCENTAGE:
      return 'Percentage';
    case PlatformFeeType.FIXED:
      return 'Fixed';
    case PlatformFeeType.COMBINED:
      return 'Percentage + Fixed';
    default:
      return 'None';
  }
}
