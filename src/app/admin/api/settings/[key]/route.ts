/**
 * Generic admin settings write. PUT /admin/api/settings/[key]  { value: string }
 *
 * Auth: reuses `authorizeDriveRequest` (the app's admin-save gate — a "drive"-
 * scoped save token minted on the admin page render, or a live Clerk admin
 * session). The `SETTING_KEYS` allowlist is the trust boundary: a key not on it
 * is rejected with 400 and never written, so this route can never be steered
 * into writing arbitrary `AppSetting` rows.
 */
import { NextRequest, NextResponse } from "next/server";
import { authorizeDriveRequest } from "@/lib/driveAuth";
import { isSettingKey, setSetting } from "@/lib/appSettings";

export const dynamic = "force-dynamic";

const MAX_CHARS = 20_000;

export async function PUT(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const denied = await authorizeDriveRequest(req);
  if (denied) return denied;

  const { key } = await ctx.params;
  if (!isSettingKey(key)) {
    return NextResponse.json({ error: "הגדרה לא מוכרת" }, { status: 400 });
  }

  let body: { value?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "בקשה לא תקינה" }, { status: 400 });
  }
  if (typeof body.value !== "string") {
    return NextResponse.json({ error: "חסר ערך" }, { status: 400 });
  }
  if (body.value.length > MAX_CHARS) {
    return NextResponse.json({ error: "הערך ארוך מדי" }, { status: 413 });
  }

  await setSetting(key, body.value);
  return NextResponse.json({ ok: true });
}
