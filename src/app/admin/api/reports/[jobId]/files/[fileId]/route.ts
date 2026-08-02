/**
 * Remove one statement file from a job.
 * DELETE /admin/api/reports/:jobId/files/:fileId
 *
 * Deletion alone changes nothing the client sees or the stored report
 * contains — the manifest is rebuilt from `StatementFile` rows fresh on every
 * dispatch (src/app/api/agent/jobs/[jobId]/manifest/route.ts), so a removed
 * file simply drops out of the next run's union. The existing report and its
 * transactions survive untouched until the admin re-runs the agent, exactly
 * like adding a file does (see files/route.ts) — only the run is the
 * state-changer, never the file list by itself.
 *
 * Same in-flight guard as the append route: a file list mutated mid-run would
 * desync from the manifest the agent already fetched.
 *
 * Drive trash is best-effort (warn, don't fail the request) — the row is the
 * source of truth for what the next run will see, and an admin who wants the
 * file gone from the job should not be blocked by a Drive hiccup.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authorizeReportsRequest } from "@/lib/reportsAdminAuth";
import { trashFile } from "@/lib/googleDrive";

export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ jobId: string; fileId: string }> },
) {
  const auth = await authorizeReportsRequest(req);
  if (auth instanceof NextResponse) return auth;

  const { jobId, fileId } = await ctx.params;
  const job = await db.reportJob.findUnique({ where: { id: jobId }, select: { id: true, status: true } });
  if (!job) return NextResponse.json({ error: "העבודה לא נמצאה" }, { status: 404 });
  if (["dispatched", "processing"].includes(job.status)) {
    return NextResponse.json(
      { error: "הסוכן עובד על העבודה הזו — יש להמתין לסיום לפני מחיקת קבצים" },
      { status: 409 },
    );
  }

  const file = await db.statementFile.findUnique({ where: { id: fileId } });
  if (!file || file.jobId !== jobId) {
    return NextResponse.json({ error: "הקובץ לא נמצא" }, { status: 404 });
  }

  await db.statementFile.delete({ where: { id: fileId } });

  try {
    await trashFile(file.driveFileId);
  } catch (e) {
    console.warn(
      `[admin/reports] job=${jobId} could not trash removed file ${file.driveFileId}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  console.log(`[admin/reports] job=${jobId} removed file=${fileId} (${file.filename}) by=${auth.actor}`);
  return NextResponse.json({ ok: true });
}
