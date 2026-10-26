-- AlterTable
ALTER TABLE "StatementFile" ADD COLUMN "sha256" TEXT;

-- CreateIndex
CREATE INDEX "StatementFile_jobId_sha256_idx" ON "StatementFile"("jobId", "sha256");
