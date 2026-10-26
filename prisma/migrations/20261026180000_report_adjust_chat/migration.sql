-- "Ask the agent" tab (docs/plans/report-adjust-chat.md B1).
ALTER TABLE "ReportJob" ADD COLUMN "adjustTokenHash" TEXT;
ALTER TABLE "ReportJob" ADD COLUMN "adjustTokenExpiresAt" TIMESTAMP(3);
ALTER TABLE "ReportJob" ADD COLUMN "adjustGeneration" TIMESTAMP(3);
ALTER TABLE "ReportJob" ADD COLUMN "rowsRevision" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ReportJob" ADD COLUMN "artifactRevision" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "ReportChatMessage" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "actor" TEXT,
    "generation" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportChatMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReportChatMessage_jobId_generation_createdAt_idx" ON "ReportChatMessage"("jobId", "generation", "createdAt");

ALTER TABLE "ReportChatMessage" ADD CONSTRAINT "ReportChatMessage_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ReportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
