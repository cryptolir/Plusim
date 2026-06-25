import { NextRequest, NextResponse } from "next/server";
import { authorizeDriveRequest } from "@/lib/driveAuth";
import {
  assertEntryUnderRoot,
  createTextFile,
  getConnectedEmail,
  DriveNotConnectedError,
  DriveOutsideRootError,
} from "@/lib/googleDrive";

export const dynamic = "force-dynamic";

function sanitizeName(s: string): string {
  return s
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function isoDate(s: string): string {
  const m = s.match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : new Date().toISOString().slice(0, 10);
}

// Writes an (admin-reviewed) summary back into the SAME folder as the source
// transcript. The parent folder is re-derived from fileId server-side, so the
// client cannot redirect the write elsewhere.
export async function POST(req: NextRequest) {
  const denied = await authorizeDriveRequest(req);
  if (denied) return denied;

  let body: { fileId?: unknown; title?: unknown; date?: unknown; summary?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (typeof body.fileId !== "string" || !body.fileId) {
    return NextResponse.json({ error: "missing fileId" }, { status: 400 });
  }
  if (typeof body.summary !== "string" || !body.summary.trim()) {
    return NextResponse.json({ error: "missing summary" }, { status: 400 });
  }
  const fileId = body.fileId;
  const title = sanitizeName(typeof body.title === "string" ? body.title : "") || "summary";
  const date = isoDate(typeof body.date === "string" ? body.date : "");
  const summary = body.summary;

  try {
    const entry = await assertEntryUnderRoot(fileId);
    const parentFolderId = entry.parents?.[0];
    if (!parentFolderId) return NextResponse.json({ error: "file has no parent folder" }, { status: 400 });

    const file = await createTextFile({
      parentFolderId,
      name: `סיכום ${date} — ${title}.txt`,
      text: summary,
      appProperties: {
        havayaSummary: "true",
        meetingDate: date,
        meetingTitle: title,
        sourceFileId: fileId,
      },
    });
    return NextResponse.json({ ok: true, file: { id: file.id, name: file.name } });
  } catch (e) {
    if (e instanceof DriveNotConnectedError) return NextResponse.json({ error: "not connected" }, { status: 409 });
    if (e instanceof DriveOutsideRootError) return NextResponse.json({ error: "file outside root" }, { status: 403 });
    const msg = e instanceof Error ? e.message : "error";
    if (/insufficientParentPermissions|\b403\b/.test(msg)) {
      const email = await getConnectedEmail();
      return NextResponse.json(
        {
          error: `The connected Google account${email ? ` (${email})` : ""} doesn't have edit access to this folder. In Google Drive, share the folder as Editor with that account (or connect as the folder's owner), then try again.`,
        },
        { status: 403 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
