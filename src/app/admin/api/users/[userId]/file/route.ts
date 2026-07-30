import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { checkAdmin } from "@/lib/adminClerk";
import { verifySaveToken } from "@/lib/adminSaveToken";
import { saveUserFileRaw } from "@/lib/agentglob";

export const dynamic = "force-dynamic";

export async function PUT(req: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;

  // Primary auth: the server-minted save token from the admin page render
  // (immune to the stale-Clerk-session problem — see lib/adminSaveToken.ts).
  // Fallback: a live Clerk session + ADMIN_EMAILS check.
  let actorEmail: string | null = null;
  const viaToken = verifySaveToken(req.headers.get("x-admin-save-token") ?? "", userId);
  if (viaToken) {
    actorEmail = viaToken.email;
  } else {
    const check = await checkAdmin();
    if (!check.ok) {
      return check.reason === "no-session"
        ? NextResponse.json({ error: "נדרשת התחברות מחדש" }, { status: 401 })
        : NextResponse.json({ error: "אין הרשאה לפעולה הזו" }, { status: 403 });
    }
    actorEmail = check.identity.email;
  }

  let body: { content?: unknown; etag?: unknown; force?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "בקשה לא תקינה" }, { status: 400 });
  }
  if (typeof body.content !== "string") {
    return NextResponse.json({ error: "בקשה לא תקינה" }, { status: 400 });
  }
  const etag = typeof body.etag === "string" ? body.etag : "";
  const force = body.force === true;

  const result = await saveUserFileRaw(userId, body.content, etag, {
    force,
    actor: actorEmail,
  });
  if (result.ok) {
    revalidateTag(`user-file:${userId}`, { expire: 0 });
    return NextResponse.json({ ok: true, etag: result.etag, fileUpdatedAt: result.fileUpdatedAt });
  }
  if (result.conflict) {
    return NextResponse.json({ error: "הקובץ השתנה מאז שנפתח", currentEtag: result.currentEtag }, { status: 409 });
  }
  return NextResponse.json({ error: result.error ?? "השמירה נכשלה" }, { status: result.status });
}
