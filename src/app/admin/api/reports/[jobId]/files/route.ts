/**
 * Append statement files to an EXISTING report job.
 * POST /admin/api/reports/:jobId/files — multipart/form-data: files[].
 *
 * This is the "update a ready report" entry point: the admin adds more
 * statements to a report that is already completed / needs_review / published,
 * then re-runs the agent (which re-parses the union and rebuilds the workbook)
 * and re-publishes. Appending alone changes NOTHING the client sees — a
 * published job stays published; the run is the state-changer.
 *
 * Guards (in order):
 *  - job exists;
 *  - not mid-run: appending while the agent is working would desync the file
 *    list from the manifest it already fetched;
 *  - Drive connected + assigned folder + folder still under the root (shared
 *    with the create route, so both writers apply identical containment);
 *  - folder-consistency: existing StatementFile rows must point at the user's
 *    CURRENT folder. The agent download route binds reads to that folder
 *    (api/agent/jobs/:id/files/:fid), so a job whose rows carry a stale
 *    driveFolderId is un-runnable — fail here, clearly, instead of mid-run.
 *
 * Rollback removes only what THIS request added: the job, its earlier files and
 * its stored report all survive a failed append.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authorizeReportsRequest } from "@/lib/reportsAdminAuth";
import { trashFile } from "@/lib/googleDrive";
import {
  prepareStatements,
  resolveTargetFolder,
  uploadStatements,
  type WrittenStatement,
} from "@/lib/reportStatementUpload";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const auth = await authorizeReportsRequest(req);
  if (auth instanceof NextResponse) return auth;

  const { jobId } = await ctx.params;
  const job = await db.reportJob.findUnique({
    where: { id: jobId },
    select: { id: true, status: true, targetUserId: true },
  });
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (["dispatched", "processing"].includes(job.status)) {
    return NextResponse.json(
      { error: "the agent is running on this job — wait for it to finish before adding files" },
      { status: 409 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }
  const prepared = await prepareStatements(form);
  if (prepared instanceof NextResponse) return prepared;

  const folderId = await resolveTargetFolder(job.targetUserId);
  if (folderId instanceof NextResponse) return folderId;

  // Every existing row must already live in the user's CURRENT folder, or the
  // re-run this append exists to enable would 404 at the agent download.
  const strayFiles = await db.statementFile.count({
    where: { jobId, driveFolderId: { not: folderId } },
  });
  if (strayFiles > 0) {
    return NextResponse.json(
      {
        error:
          "this job's statement files live in a previously assigned Drive folder — reassign the original folder or create a new job",
      },
      { status: 409 },
    );
  }

  const written: WrittenStatement[] = [];
  try {
    await uploadStatements({ jobId, folderId, prepared, written });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[admin/reports] job=${jobId} append failed, rolling back ${written.length}: ${msg}`);
    // Every uploaded file is trashed — including one whose row insert failed.
    await Promise.allSettled(written.map((w) => trashFile(w.driveFileId)));
    const rowIds = written.map((w) => w.rowId).filter((id): id is string => id !== null);
    try {
      if (rowIds.length > 0) await db.statementFile.deleteMany({ where: { id: { in: rowIds } } });
    } catch (e) {
      // Rows without their Drive files are dead weight, but the job is intact
      // and a re-append is safe — never turn cleanup into a second failure.
      console.error(
        `[admin/reports] job=${jobId} rollback left ${written.length} orphan row(s): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return NextResponse.json({ error: `Drive upload failed: ${msg}` }, { status: 502 });
  }

  console.log(
    `[admin/reports] job=${jobId} appended files=${prepared.length} by=${auth.actor} status=${job.status}`,
  );
  return NextResponse.json({ ok: true, added: prepared.length });
}
