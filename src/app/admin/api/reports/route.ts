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
import {
  isDriveConnected,
  assertEntryUnderRoot,
  uploadBinaryFile,
  trashFile,
  DriveNotConnectedError,
} from "@/lib/googleDrive";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 12;

function sniffMime(name: string, buf: Buffer): string | null {
  const isZip = buf.length > 3 && buf[0] === 0x50 && buf[1] === 0x4b;
  const isPdf = buf.length > 4 && buf.subarray(0, 5).toString("latin1") === "%PDF-";
  const lower = name.toLowerCase();
  if (isZip && lower.endsWith(".xlsx")) {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (isPdf && lower.endsWith(".pdf")) return "application/pdf";
  return null;
}

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

  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) return NextResponse.json({ error: "no files" }, { status: 400 });
  if (files.length > MAX_FILES) return NextResponse.json({ error: `max ${MAX_FILES} files` }, { status: 400 });

  const prepared: { filename: string; mime: string; size: number; bytes: Buffer }[] = [];
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: `${f.name}: over 10MB` }, { status: 400 });
    }
    const bytes = Buffer.from(await f.arrayBuffer());
    const mime = sniffMime(f.name, bytes);
    if (!mime) {
      return NextResponse.json(
        { error: `${f.name}: only .xlsx and .pdf statements are accepted` },
        { status: 400 },
      );
    }
    prepared.push({ filename: f.name.slice(0, 200), mime, size: bytes.length, bytes });
  }

  // Precondition: Drive connected + the target user has an assigned folder.
  if (!(await isDriveConnected())) {
    return NextResponse.json({ error: "Google Drive is not connected" }, { status: 409 });
  }
  const folder = await db.userDriveFolder.findUnique({ where: { userId: targetUserId } });
  if (!folder) {
    return NextResponse.json(
      { error: "target user has no assigned Drive folder — assign one first" },
      { status: 409 },
    );
  }
  // Re-contain the assigned folder AT WRITE TIME: it may have been moved outside
  // the root or deleted since assignment (Rev 4 — Codex P1). Refuse, write nothing.
  try {
    await assertEntryUnderRoot(folder.folderId);
  } catch (e) {
    if (e instanceof DriveNotConnectedError) {
      return NextResponse.json({ error: "Google Drive is not connected" }, { status: 409 });
    }
    return NextResponse.json(
      { error: "assigned Drive folder is missing or outside the root — reassign it" },
      { status: 409 },
    );
  }

  // Create the job first so uploaded files can be tagged with its id, then write
  // each statement into the user's folder. On any Drive failure, trash what we
  // wrote and drop the job — no half-populated job survives.
  const job = await db.reportJob.create({
    data: { targetUserId, createdBy: auth.actor, title },
    select: { id: true },
  });

  const uploadedIds: string[] = [];
  try {
    for (const p of prepared) {
      const entry = await uploadBinaryFile({
        parentFolderId: folder.folderId,
        name: p.filename,
        mime: p.mime,
        bytes: p.bytes,
        appProperties: { plusimStatement: "true", plusimJobId: job.id },
      });
      uploadedIds.push(entry.id);
      await db.statementFile.create({
        data: {
          jobId: job.id,
          filename: p.filename,
          mime: p.mime,
          size: p.size,
          driveFileId: entry.id,
          driveFolderId: folder.folderId,
        },
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[admin/reports] job=${job.id} upload failed, rolling back: ${msg}`);
    await Promise.allSettled(uploadedIds.map((id) => trashFile(id)));
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
