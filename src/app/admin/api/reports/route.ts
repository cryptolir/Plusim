/**
 * Reports admin API — create a job (multipart upload) + list jobs.
 *
 * POST multipart/form-data: targetUserId, title?, files[] (.xlsx/.pdf ≤10MB).
 * Files are content-sniffed (zip/PDF magic bytes) and written into the target
 * user's assigned Google Drive folder (never Postgres) — the same owner-OAuth
 * routine as the meeting summaries. StatementFile keeps only the Drive ids + metadata.
 *
 * The parent folder always comes from the DB (`UserDriveFolder`), never the
 * request, and is re-contained with assertEntryUnderRoot at write time — the
 * assignment could have been moved outside the root or deleted since (Rev 4).
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authorizeReportsRequest } from "@/lib/reportsAdminAuth";
import { trashFile } from "@/lib/googleDrive";
import { prepareStatements, resolveTargetFolder, uploadStatements } from "@/lib/reportStatementUpload";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const auth = await authorizeReportsRequest(req);
  if (auth instanceof NextResponse) return auth;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart/form-data" }, { status: 400 });
  }

  const targetUserId = String(form.get("targetUserId") ?? "").trim();
  const title = String(form.get("title") ?? "").trim().slice(0, 120) || null;
  if (!targetUserId) return NextResponse.json({ error: "targetUserId required" }, { status: 400 });

  const prepared = await prepareStatements(form);
  if (prepared instanceof NextResponse) return prepared;

  // Precondition: Drive connected + the target user has an assigned folder that
  // is still under the root (re-contained at write time).
  const folderId = await resolveTargetFolder(targetUserId);
  if (folderId instanceof NextResponse) return folderId;

  // Create the job first so uploaded files can be tagged with its id, then write
  // each statement into the user's folder. On any Drive failure, trash what we
  // wrote and drop the job — no half-populated job survives.
  const job = await db.reportJob.create({
    data: { targetUserId, createdBy: auth.actor, title },
    select: { id: true },
  });

  const written: { driveFileId: string; rowId: string }[] = [];
  try {
    await uploadStatements({ jobId: job.id, folderId, prepared, written });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[admin/reports] job=${job.id} upload failed, rolling back: ${msg}`);
    await Promise.allSettled(written.map((w) => trashFile(w.driveFileId)));
    await db.reportJob.delete({ where: { id: job.id } }).catch(() => {});
    return NextResponse.json({ error: `Drive upload failed: ${msg}` }, { status: 502 });
  }

  console.log(`[admin/reports] job=${job.id} created by=${auth.actor} files=${prepared.length} → drive`);
  return NextResponse.json({ ok: true, jobId: job.id });
}

export async function GET(req: NextRequest) {
  const auth = await authorizeReportsRequest(req);
  if (auth instanceof NextResponse) return auth;

  const jobs = await db.reportJob.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      targetUserId: true,
      status: true,
      title: true,
      error: true,
      sheetUrl: true,
      createdAt: true,
      dispatchedAt: true,
      completedAt: true,
      publishedAt: true,
      _count: { select: { files: true, transactions: true } },
    },
  });
  return NextResponse.json({ jobs });
}
