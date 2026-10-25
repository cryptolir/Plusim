-- AlterTable
ALTER TABLE "ReportTransaction" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'expense';

-- CreateTable
CREATE TABLE "ReportSettlement" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "payee" TEXT NOT NULL,
    "amountAgorot" INTEGER NOT NULL,
    "sourceLabel" TEXT NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "matchedCycle" TEXT,

    CONSTRAINT "ReportSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReportSettlement_jobId_month_idx" ON "ReportSettlement"("jobId", "month");

-- AddForeignKey
ALTER TABLE "ReportSettlement" ADD CONSTRAINT "ReportSettlement_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ReportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
