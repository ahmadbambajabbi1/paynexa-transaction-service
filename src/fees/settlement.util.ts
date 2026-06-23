import { Prisma } from '@prisma/client';
import {
  calculatePlatformFee,
  type FeeConfigInput,
  type FeeBreakdown,
} from './platform-fee.util';

/** Platform (admin) fee on list price; seller payout is capped by net funds received. */
export function computeSellerPayoutFromNet(params: {
  transactionAmount: string | number;
  netReceived: string | number;
  feeConfig: FeeConfigInput;
}): FeeBreakdown & { netReceived: string } {
  const net = new Prisma.Decimal(String(params.netReceived)).toDecimalPlaces(
    2,
    Prisma.Decimal.ROUND_HALF_UP,
  );
  const breakdown = calculatePlatformFee(params.transactionAmount, params.feeConfig);
  let platformFee = new Prisma.Decimal(breakdown.platformFeeAmount);
  if (platformFee.gt(net)) {
    platformFee = net;
  }
  const sellerNet = net.sub(platformFee).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  return {
    ...breakdown,
    platformFeeAmount: platformFee.toString(),
    sellerNetAmount: sellerNet.toString(),
    netReceived: net.toString(),
  };
}
