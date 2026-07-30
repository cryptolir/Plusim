-- AlterTable
ALTER TABLE "ReportJob" ADD COLUMN     "dispatchAttemptedAt" TIMESTAMP(3),
ADD COLUMN     "queueJobId" TEXT;
