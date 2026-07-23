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
  if (files.length === 0) return NextResponse.json({ error: "no files" }, { status: 400 });
  if (files.length > MAX_FILES) return NextResponse.json({ error: `max ${MAX_FILES} files` }, { status: 400 });

  const prepared: PreparedStatement[] = [];
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
  return prepared;
}

/**
 * Drive connected + the target user has an assigned folder + that folder is
 * STILL under the configured root. Returns the folder id, or a NextResponse.
 */
export async function resolveTargetFolder(targetUserId: string): Promise<string | NextResponse> {
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
  return folder.folderId;
}

/**
 * Write each statement into the folder and record a StatementFile row.
 * Throws on the first Drive failure — the caller rolls back using `written`,
 * which is mutated in place so a partial run is still fully known.
 */
export async function uploadStatements(opts: {
  jobId: string;
  folderId: string;
  prepared: PreparedStatement[];
  written: { driveFileId: string; rowId: string }[];
}): Promise<void> {
  for (const p of opts.prepared) {
    const entry = await uploadBinaryFile({
      parentFolderId: opts.folderId,
      name: p.filename,
      mime: p.mime,
      bytes: p.bytes,
      appProperties: { plusimStatement: "true", plusimJobId: opts.jobId },
    });
    const row = await db.statementFile.create({
      data: {
        jobId: opts.jobId,
        filename: p.filename,
        mime: p.mime,
        size: p.size,
        driveFileId: entry.id,
        driveFolderId: opts.folderId,
      },
      select: { id: true },
    });
    opts.written.push({ driveFileId: entry.id, rowId: row.id });
  }
}
