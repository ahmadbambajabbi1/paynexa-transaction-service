-- CreateEnum
CREATE TYPE "PlatformFeeType" AS ENUM ('NONE', 'PERCENTAGE', 'FIXED', 'COMBINED');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'COUNTERED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "DisputeResolution" AS ENUM ('RELEASE_TO_SELLER', 'REFUND_TO_BUYER');

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "currencyCode" VARCHAR(3) NOT NULL DEFAULT 'USD';
ALTER TABLE "Transaction" ADD COLUMN "platformFeeAmount" DECIMAL(18,2);
ALTER TABLE "Transaction" ADD COLUMN "platformFeeType" "PlatformFeeType";
ALTER TABLE "Transaction" ADD COLUMN "platformFeePercent" DECIMAL(8,4);
ALTER TABLE "Transaction" ADD COLUMN "platformFeeFixed" DECIMAL(18,2);
ALTER TABLE "Transaction" ADD COLUMN "sellerNetAmount" DECIMAL(18,2);
ALTER TABLE "Transaction" ADD COLUMN "deliveryDetails" JSONB;

-- CreateTable
CREATE TABLE "TransactionDispute" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "raisedByUserId" TEXT NOT NULL,
    "raisedByRole" TEXT NOT NULL,
    "description" VARCHAR(500) NOT NULL,
    "parentDisputeId" TEXT,
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "resolution" "DisputeResolution",
    "resolutionReason" TEXT,
    "internalNotes" TEXT,
    "resolvedByAdminId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionDispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionDisputeResponse" (
    "id" TEXT NOT NULL,
    "disputeId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "message" VARCHAR(500) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionDisputeResponse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TransactionDispute_transactionId_createdAt_idx" ON "TransactionDispute"("transactionId", "createdAt");

-- CreateIndex
CREATE INDEX "TransactionDispute_status_idx" ON "TransactionDispute"("status");

-- AddForeignKey
ALTER TABLE "TransactionDispute" ADD CONSTRAINT "TransactionDispute_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionDispute" ADD CONSTRAINT "TransactionDispute_parentDisputeId_fkey" FOREIGN KEY ("parentDisputeId") REFERENCES "TransactionDispute"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionDisputeResponse" ADD CONSTRAINT "TransactionDisputeResponse_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "TransactionDispute"("id") ON DELETE CASCADE ON UPDATE CASCADE;
