/**
 * Shared statement-upload steps for the two admin routes that write raw
 * statements into a client's Drive folder: create-a-job (POST /admin/api/reports)
 * and append-to-a-job (POST /admin/api/reports/:jobId/files).
 *
 * Both must apply the SAME trust rules, so they live here once:
 *  - content-sniffed mime (magic bytes), size + count caps;
 *  - the parent folder always comes from the DB (`UserDriveFolder`), never the
 *    request, and is re-contained with assertEntryUnderRoot AT WRITE TIME (the
 *    assignment could have been moved outside the root or deleted since).
 *
 * Rollback differs per caller and stays there: create drops the whole job,
 * append removes only what it just added.
 */
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  isDriveConnected,
  assertEntryUnderRoot,
  uploadBinaryFile,
  DriveNotConnectedError,
} from "@/lib/googleDrive";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES = 12;

export interface PreparedStatement {
  filename: string;
  mime: string;
  size: number;
  bytes: Buffer;
  /** sha256 hex of `bytes` — identical-file refusal and the future parse cache key. */
  sha256: string;
}

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

/** Validate + read the multipart `files[]`. Returns a NextResponse to return as-is on refusal. */
export async function prepareStatements(form: FormData): Promise<PreparedStatement[] | NextResponse> {
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) return NextResponse.json({ error: "לא נבחרו קבצים" }, { status: 400 });
  if (files.length > MAX_FILES) return NextResponse.json({ error: `אפשר להעלות עד ${MAX_FILES} קבצים` }, { status: 400 });

  const prepared: PreparedStatement[] = [];
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: `${f.name}: הקובץ גדול מ-10MB` }, { status: 400 });
    }
    const bytes = Buffer.from(await f.arrayBuffer());
    const mime = sniffMime(f.name, bytes);
    if (!mime) {
      return NextResponse.json(
        { error: `${f.name}: ניתן להעלות רק דפי חשבון בפורמט .xlsx או .pdf` },
        { status: 400 },
      );
    }
    prepared.push({
      filename: f.name.slice(0, 200),
      mime,
      size: bytes.length,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return prepared;
}

/**
 * Refuse byte-identical statements (docs/plans/scale-large-statements.md B2):
 *  - two identical files in the SAME request, and
 *  - when `jobId` is given (append), a file whose bytes are already on THIS job.
 * The same bytes on ANOTHER job are fine — that is a different report. An identical
 * file can never add a transaction, but an overlapping re-export is the normal case
 * and is merged by the agent; this only stops the exact re-upload before it costs a
 * Drive write and a parse. Returns a NextResponse to return as-is, or null.
 */
export async function refuseDuplicateStatements(
  prepared: PreparedStatement[],
  jobId?: string,
): Promise<NextResponse | null> {
  const first = new Map<string, string>();
  for (const p of prepared) {
    const earlier = first.get(p.sha256);
    if (earlier !== undefined) {
      return NextResponse.json(
        { error: `${p.filename}: זהה לקובץ ${earlier} שנבחר באותה העלאה` },
        { status: 409 },
      );
    }
    first.set(p.sha256, p.filename);
  }
  if (!jobId) return null;
  const existing = await db.statementFile.findMany({
    where: { jobId, sha256: { in: prepared.map((p) => p.sha256) } },
    select: { sha256: true, filename: true },
  });
  if (existing.length > 0) {
    const hit = prepared.find((p) => p.sha256 === existing[0].sha256)!;
    return NextResponse.json(
      { error: `${hit.filename}: הקובץ כבר הועלה לעבודה הזו (${existing[0].filename})` },
      { status: 409 },
    );
  }
  return null;
}

/**
 * Drive connected + the target user has an assigned folder + that folder is
 * STILL under the configured root. Returns the folder id, or a NextResponse.
 */
export async function resolveTargetFolder(targetUserId: string): Promise<string | NextResponse> {
  if (!(await isDriveConnected())) {
    return NextResponse.json({ error: "Google Drive לא מחובר" }, { status: 409 });
  }
  const folder = await db.userDriveFolder.findUnique({ where: { userId: targetUserId } });
  if (!folder) {
    return NextResponse.json(
      { error: "למשתמש היעד לא הוקצתה תיקיית Drive — יש להקצות תיקייה תחילה" },
      { status: 409 },
    );
  }
  try {
    await assertEntryUnderRoot(folder.folderId);
  } catch (e) {
    if (e instanceof DriveNotConnectedError) {
      return NextResponse.json({ error: "Google Drive לא מחובר" }, { status: 409 });
    }
    return NextResponse.json(
      { error: "תיקיית ה-Drive שהוקצתה חסרה או נמצאת מחוץ לתיקיית השורש — יש להקצות אותה מחדש" },
      { status: 409 },
    );
  }
  return folder.folderId;
}

export interface WrittenStatement {
  driveFileId: string;
  /** null until the row insert succeeds — the Drive file can outlive a failed insert. */
  rowId: string | null;
}

/**
 * Write each statement into the folder and record a StatementFile row.
 * Throws on the first failure — the caller rolls back using `written`, which is
 * mutated in place so a partial run is still fully known.
 *
 * The Drive id is recorded BEFORE the row insert: an upload that succeeds while
 * its insert fails would otherwise leave a statement in the client's folder that
 * no rollback can reach.
 */
export async function uploadStatements(opts: {
  jobId: string;
  folderId: string;
  prepared: PreparedStatement[];
  written: WrittenStatement[];
}): Promise<void> {
  for (const p of opts.prepared) {
    const entry = await uploadBinaryFile({
      parentFolderId: opts.folderId,
      name: p.filename,
      mime: p.mime,
      bytes: p.bytes,
      appProperties: { plusimStatement: "true", plusimJobId: opts.jobId },
    });
    const written: WrittenStatement = { driveFileId: entry.id, rowId: null };
    opts.written.push(written);
    const row = await db.statementFile.create({
      data: {
        jobId: opts.jobId,
        filename: p.filename,
        mime: p.mime,
        size: p.size,
        driveFileId: entry.id,
        driveFolderId: opts.folderId,
        sha256: p.sha256,
      },
      select: { id: true },
    });
    written.rowId = row.id;
  }
}
