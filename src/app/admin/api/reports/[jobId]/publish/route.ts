/**
 * Publish a completed report to its target user, exporting the xlsx artifact
 * to Google Sheets in the user's assigned Drive folder (best-effort: a missing
 * Drive connection or folder skips the export rather than blocking publish).
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authorizeReportsRequest } from "@/lib/reportsAdminAuth";
import {
  isDriveConnected,
  assertEntryUnderRoot,
  uploadXlsxAsSpreadsheet,
} from "@/lib/googleDrive";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const auth = await authorizeReportsRequest(req);
  if (auth instanceof NextResponse) return auth;

  const { jobId } = await ctx.params;
  const job = await db.reportJob.findUnique({
    where: { id: jobId },
    select: { id: true, status: true, targetUserId: true, title: true, sheetUrl: true },
  });
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!["completed", "needs_review", "published"].includes(job.status)) {
    return NextResponse.json({ error: `cannot publish a ${job.status} job` }, { status: 409 });
  }
  const remainingUncat = await db.reportTransaction.count({
    where: { jobId, uncategorized: true },
  });

  // Sheets export (best-effort). Skipped silently when Drive is not connected
  // or the user has no assigned folder; re-publish reuses the existing sheet.
  let sheetUrl = job.sheetUrl;
  let exportNote: string | null = null;
  if (!sheetUrl) {
    try {
      if (await isDriveConnected()) {
        const folder = await db.userDriveFolder.findUnique({ where: { userId: job.targetUserId } });
        if (folder) {
          const artifact = await db.reportArtifact.findFirst({
            where: { jobId, kind: "xlsx" },
            orderBy: { createdAt: "desc" },
          });
          if (artifact) {
            await assertEntryUnderRoot(folder.folderId);
            const entry = await uploadXlsxAsSpreadsheet({
              parentFolderId: folder.folderId,
              name: job.title || artifact.filename.replace(/\.xlsx$/i, ""),
              xlsx: Buffer.from(artifact.bytes),
              appProperties: { plusimReport: "true", plusimJobId: jobId },
            });
            sheetUrl = `https://docs.google.com/spreadsheets/d/${entry.id}/edit`;
          } else {
            exportNote = "no xlsx artifact to export";
          }
        } else {
          exportNote = "user has no assigned Drive folder — sheet export skipped";
        }
      } else {
        exportNote = "Drive not connected — sheet export skipped";
      }
    } catch (e) {
      exportNote = `sheet export failed: ${e instanceof Error ? e.message : String(e)}`;
      console.error(`[admin/reports] job=${jobId} ${exportNote}`);
    }
  }

  await db.reportJob.update({
    where: { id: jobId },
    data: {
      status: "published",
      publishedAt: new Date(),
      sheetUrl,
      // Published jobs must not accept late agent callbacks.
      agentTokenHash: null,
      agentTokenExpiresAt: null,
    },
  });

  console.log(
    `[admin/reports] job=${jobId} published by=${auth.actor} uncatLeft=${remainingUncat} sheet=${sheetUrl ? "yes" : "no"}`,
  );
  return NextResponse.json({ ok: true, sheetUrl, remainingUncategorized: remainingUncat, exportNote });
}
