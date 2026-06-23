/**
 * Resolves list-price currency from row + terms JSON (terms win when present).
 */
export function resolveTransactionCurrency(tx: {
  currencyCode?: string | null;
  terms?: string | null;
}): string {
  if (tx.terms) {
    try {
      const parsed = JSON.parse(tx.terms) as { currencyCode?: unknown };
      if (typeof parsed.currencyCode === 'string' && parsed.currencyCode.trim()) {
        return parsed.currencyCode.trim().toUpperCase();
      }
    } catch {
      // ignore malformed terms
    }
  }
  const code = tx.currencyCode?.trim().toUpperCase();
  return code || 'USD';
}
