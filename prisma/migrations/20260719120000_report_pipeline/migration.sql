-- CreateTable
CREATE TABLE "ReportJob" (
    "id" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'uploaded',
    "title" TEXT,
    "error" TEXT,
    "verification" JSONB,
    "sheetUrl" TEXT,
    "agentTokenHash" TEXT,
    "agentTokenExpiresAt" TIMESTAMP(3),
    "dispatchedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatementFile" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "sourceLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatementFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportArtifact" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportTransaction" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "merchant" TEXT NOT NULL,
    "amountAgorot" INTEGER NOT NULL,
    "category" TEXT,
    "uncategorized" BOOLEAN NOT NULL DEFAULT false,
    "sourceLabel" TEXT NOT NULL,
    "note" TEXT,
    "dedupKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantMapping" (
    "id" TEXT NOT NULL,
    "merchantPattern" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MerchantMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReportJob_targetUserId_publishedAt_idx" ON "ReportJob"("targetUserId", "publishedAt" DESC);

-- CreateIndex
CREATE INDEX "ReportJob_status_updatedAt_idx" ON "ReportJob"("status", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "StatementFile_jobId_idx" ON "StatementFile"("jobId");

-- CreateIndex
CREATE INDEX "ReportArtifact_jobId_kind_idx" ON "ReportArtifact"("jobId", "kind");

-- CreateIndex
CREATE INDEX "ReportTransaction_jobId_month_idx" ON "ReportTransaction"("jobId", "month");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantMapping_merchantPattern_key" ON "MerchantMapping"("merchantPattern");

-- CreateIndex
CREATE INDEX "MerchantMapping_approved_idx" ON "MerchantMapping"("approved");

-- AddForeignKey
ALTER TABLE "StatementFile" ADD CONSTRAINT "StatementFile_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ReportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportArtifact" ADD CONSTRAINT "ReportArtifact_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ReportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportTransaction" ADD CONSTRAINT "ReportTransaction_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ReportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

