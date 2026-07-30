import { NextRequest, NextResponse } from "next/server";
import { checkAdmin } from "@/lib/adminClerk";
import { verifySaveToken } from "@/lib/adminSaveToken";
import { db } from "@/lib/db";
import { assertEntryUnderRoot, DriveNotConnectedError, DriveOutsideRootError } from "@/lib/googleDrive";

export const dynamic = "force-dynamic";

// Per-user-scoped dual-auth (mirrors the user-file route): the save token is
// scoped to this userId, with a live admin Clerk session as fallback.
async function authorize(req: NextRequest, userId: string): Promise<NextResponse | null> {
  if (verifySaveToken(req.headers.get("x-admin-save-token") ?? "", userId)) return null;
  const check = await checkAdmin();
  if (check.ok) return null;
  return check.reason === "no-session"
    ? NextResponse.json({ error: "נדרשת התחברות מחדש" }, { status: 401 })
    : NextResponse.json({ error: "אין הרשאה לפעולה הזו" }, { status: 403 });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  const denied = await authorize(req, userId);
  if (denied) return denied;

  let body: { folderId?: unknown; folderName?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "בקשה לא תקינה" }, { status: 400 });
  }
  if (typeof body.folderId !== "string" || !body.folderId) {
    return NextResponse.json({ error: "חסר מזהה תיקייה" }, { status: 400 });
  }
  const folderName = typeof body.folderName === "string" ? body.folderName : null;

  // Containment guard: the folder must live under the configured transcripts root.
  try {
    const entry = await assertEntryUnderRoot(body.folderId);
    if (!entry.isFolder) return NextResponse.json({ error: "הפריט שנבחר אינו תיקייה" }, { status: 400 });
  } catch (e) {
    if (e instanceof DriveNotConnectedError) return NextResponse.json({ error: "Google Drive לא מחובר" }, { status: 409 });
    if (e instanceof DriveOutsideRootError)
      return NextResponse.json({ error: "התיקייה נמצאת מחוץ לתיקיית השורש המוגדרת" }, { status: 403 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "error" }, { status: 500 });
  }

  await db.userDriveFolder.upsert({
    where: { userId },
    update: { folderId: body.folderId, folderName },
    create: { userId, folderId: body.folderId, folderName },
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  const denied = await authorize(req, userId);
  if (denied) return denied;
  await db.userDriveFolder.deleteMany({ where: { userId } });
  return NextResponse.json({ ok: true });
}
