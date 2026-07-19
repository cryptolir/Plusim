/**
 * Agent-facing statement download. GET /api/agent/jobs/:jobId/files/:fileId?t=…
 *
 * The bytes live in the job user's Google Drive folder. The read is bound to
 * that folder, not merely the owner root (Rev 2 — Codex P1):
 *   1. StatementFile must belong to this jobId (404 otherwise).
 *   2. The row's driveFolderId must still equal the job user's CURRENT
 *      UserDriveFolder.folderId (404 otherwise — stale/cross-linked row).
 *   3. assertEntryUnderFolder(driveFileId, folderId) must pass — the file's Drive
 *      parent chain reaches that folder (403 otherwise). A file sitting in some
 *      OTHER user's folder under the same root is rejected here.
 * The agent never supplies a Drive id; it comes from the DB, contained at read.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authorizeAgentJobRequest } from "@/lib/agentRuntimeAuth";
import { assertEntryUnderFolder, getFileBytes, DriveOutsideRootError } from "@/lib/googleDrive";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ jobId: string; fileId: string }> },
) {
  const { jobId, fileId } = await ctx.params;
  const auth = await authorizeAgentJobRequest(req, jobId);
  if (auth instanceof NextResponse) return auth;

  const file = await db.statementFile.findFirst({ where: { id: fileId, jobId } });
  if (!file) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Bind the read to the job user's CURRENT folder — reject a stale/cross-linked
  // driveFolderId that no longer matches (or was never) this user's folder.
  const folder = await db.userDriveFolder.findUnique({ where: { userId: auth.job.targetUserId } });
  if (!folder || folder.folderId !== file.driveFolderId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  let bytes: Buffer;
  try {
    const entry = await assertEntryUnderFolder(file.driveFileId, folder.folderId);
    bytes = await getFileBytes(entry);
  } catch (e) {
    if (e instanceof DriveOutsideRootError) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[agent/files] job=${jobId} file=${fileId} drive read failed: ${msg}`);
    return NextResponse.json({ error: "drive read failed" }, { status: 502 });
  }

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "content-type": file.mime,
      "content-length": String(bytes.length),
      "content-disposition": `attachment; filename="${encodeURIComponent(file.filename)}"`,
      "cache-control": "no-store",
    },
  });
}
