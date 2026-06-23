-- Backfill currency on buyer orders copied from share templates (schema default was USD).
UPDATE "Transaction" AS child
SET "currencyCode" = parent."currencyCode"
FROM "Transaction" AS parent
WHERE child."sourceShareTransactionId" = parent.id
  AND parent."currencyCode" IS NOT NULL
  AND child."currencyCode" IS DISTINCT FROM parent."currencyCode";
