-- One buyer order per user per shareable payment-link template.
CREATE UNIQUE INDEX "Transaction_sourceShare_buyer_unique"
ON "Transaction"("sourceShareTransactionId", "buyerId")
WHERE "sourceShareTransactionId" IS NOT NULL AND "buyerId" IS NOT NULL;
