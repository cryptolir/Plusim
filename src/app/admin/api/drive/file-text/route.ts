import { NextRequest, NextResponse } from "next/server";
import { authorizeDriveRequest } from "@/lib/driveAuth";
import {
  assertEntryUnderRoot,
  getFileText,
  updateTextFile,
  DriveNotConnectedError,
  DriveOutsideRootError,
  UnsupportedTranscriptTypeError,
} from "@/lib/googleDrive";

export const dynamic = "force-dynamic";

const MAX_PREVIEW = 200_000;
const MAX_EDIT_CHARS = 500_000;

function errorResponse(e: unknown): NextResponse {
  if (e instanceof DriveNotConnectedError) return NextResponse.json({ error: "Google Drive לא מחובר" }, { status: 409 });
  if (e instanceof DriveOutsideRootError) return NextResponse.json({ error: "הקובץ נמצא מחוץ לתיקיית השורש המוגדרת" }, { status: 403 });
  if (e instanceof UnsupportedTranscriptTypeError)
    return NextResponse.json({ error: "לא ניתן לערוך כאן קובץ מסוג זה" }, { status: 415 });
  return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 500 });
}

export async function GET(req: NextRequest) {
  const denied = await authorizeDriveRequest(req);
  if (denied) return denied;

  const fileId = new URL(req.url).searchParams.get("fileId");
  if (!fileId) return NextResponse.json({ error: "חסר מזהה קובץ" }, { status: 400 });

  try {
    const entry = await assertEntryUnderRoot(fileId); // also rejects files outside the root tree
    const text = await getFileText(entry);
    return NextResponse.json({ name: entry.name, text: text.slice(0, MAX_PREVIEW) });
  } catch (e) {
    return errorResponse(e);
  }
}

// Overwrite a transcript's raw text (edit-before-summarize, saved back to Drive).
export async function PUT(req: NextRequest) {
  const denied = await authorizeDriveRequest(req);
  if (denied) return denied;

  let body: { fileId?: unknown; text?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "בקשה לא תקינה" }, { status: 400 });
  }
  if (typeof body.fileId !== "string" || !body.fileId) {
    return NextResponse.json({ error: "חסר מזהה קובץ" }, { status: 400 });
  }
  if (typeof body.text !== "string") {
    return NextResponse.json({ error: "חסר תוכן לשמירה" }, { status: 400 });
  }
  if (body.text.length > MAX_EDIT_CHARS) {
    return NextResponse.json({ error: "הטקסט ארוך מדי" }, { status: 413 });
  }

  try {
    const entry = await assertEntryUnderRoot(body.fileId);
    const updated = await updateTextFile(entry, body.text);
    return NextResponse.json({ ok: true, name: updated.name });
  } catch (e) {
    return errorResponse(e);
  }
}
