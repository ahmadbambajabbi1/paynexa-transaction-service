import type { PlatformFeeType } from '@prisma/client';
import { formatFeeTypeLabel } from '../fees/platform-fee.util';

export function hydrateTransactionFeeFields(tx: {
  amount: { toString(): string } | string;
  platformFeeAmount?: { toString(): string } | string | null;
  platformFeeType?: PlatformFeeType | null;
  platformFeePercent?: { toString(): string } | string | null;
  platformFeeFixed?: { toString(): string } | string | null;
  sellerNetAmount?: { toString(): string } | string | null;
  terms?: string | null;
}) {
  let terms: Record<string, unknown> = {};
  if (tx.terms) {
    try {
      terms = JSON.parse(tx.terms) as Record<string, unknown>;
    } catch {
      terms = {};
    }
  }

  const amount = typeof tx.amount === 'string' ? tx.amount : tx.amount.toString();
  const platformFeeAmount =
    tx.platformFeeAmount?.toString() ??
    (typeof terms.platformFeeAmount === 'string' ? terms.platformFeeAmount : null);
  const platformFeeType =
    tx.platformFeeType ??
    (typeof terms.platformFeeType === 'string'
      ? (terms.platformFeeType as PlatformFeeType)
      : null);
  const sellerNetAmount =
    tx.sellerNetAmount?.toString() ??
    (typeof terms.sellerNetAmount === 'string' ? terms.sellerNetAmount : null);

  return {
    amount,
    platformFeeAmount,
    platformFeeType,
    platformFeeTypeLabel: formatFeeTypeLabel(platformFeeType),
    platformFeePercent: tx.platformFeePercent?.toString() ?? null,
    platformFeeFixed: tx.platformFeeFixed?.toString() ?? null,
    sellerNetAmount,
  };
}
