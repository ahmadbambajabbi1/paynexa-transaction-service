-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('ONLINE_SHOPPING', 'LAND', 'REAL_ESTATE');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('AWAITING_ACCEPTANCE', 'AWAITING_FUNDING', 'FUNDED', 'IN_PROGRESS', 'INSPECTION', 'COMPLETED', 'DISPUTED', 'REFUNDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "TransactionFundingParty" AS ENUM ('ME', 'COUNTERPARTY');

-- CreateEnum
CREATE TYPE "TransactionWorkflow" AS ENUM ('PUBLIC_SHAREABLE', 'ESCROW_TWO_PARTY');

-- CreateEnum
CREATE TYPE "ParticipantInviteStatus" AS ENUM ('NONE', 'PENDING', 'ACCEPTED');

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "workflow" "TransactionWorkflow" NOT NULL DEFAULT 'ESCROW_TWO_PARTY',
    "shareToken" TEXT,
    "sourceShareTransactionId" TEXT,
    "type" "TransactionType" NOT NULL,
    "productId" TEXT,
    "productTitle" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" DECIMAL(18,2),
    "amount" DECIMAL(18,2) NOT NULL,
    "buyerId" TEXT,
    "sellerId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "fundedBy" "TransactionFundingParty" NOT NULL,
    "terms" TEXT NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'AWAITING_ACCEPTANCE',
    "acceptedPartyIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "buyerLawyerId" TEXT,
    "buyerLawyerInviteStatus" "ParticipantInviteStatus" NOT NULL DEFAULT 'NONE',
    "buyerAgentId" TEXT,
    "buyerAgentInviteStatus" "ParticipantInviteStatus" NOT NULL DEFAULT 'NONE',
    "sellerLawyerId" TEXT,
    "sellerLawyerInviteStatus" "ParticipantInviteStatus" NOT NULL DEFAULT 'NONE',
    "sellerAgentId" TEXT,
    "sellerAgentInviteStatus" "ParticipantInviteStatus" NOT NULL DEFAULT 'NONE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionPublicView" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "deviceId" TEXT,
    "viewerUserId" TEXT,
    "userAgent" TEXT,
    "convertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionPublicView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionDocument" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "uploader" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgreementVersion" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgreementVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionAudit" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "detail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionNotification" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_shareToken_key" ON "Transaction"("shareToken");

-- CreateIndex
CREATE INDEX "TransactionPublicView_transactionId_createdAt_idx" ON "TransactionPublicView"("transactionId", "createdAt");

-- CreateIndex
CREATE INDEX "TransactionPublicView_transactionId_deviceId_idx" ON "TransactionPublicView"("transactionId", "deviceId");

-- CreateIndex
CREATE INDEX "TransactionPublicView_transactionId_viewerUserId_idx" ON "TransactionPublicView"("transactionId", "viewerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "AgreementVersion_transactionId_version_key" ON "AgreementVersion"("transactionId", "version");

-- CreateIndex
CREATE INDEX "TransactionNotification_recipientId_createdAt_idx" ON "TransactionNotification"("recipientId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_sourceShareTransactionId_fkey" FOREIGN KEY ("sourceShareTransactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionPublicView" ADD CONSTRAINT "TransactionPublicView_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionDocument" ADD CONSTRAINT "TransactionDocument_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgreementVersion" ADD CONSTRAINT "AgreementVersion_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionAudit" ADD CONSTRAINT "TransactionAudit_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionNotification" ADD CONSTRAINT "TransactionNotification_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
