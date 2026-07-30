/** Reports admin API — approve / reject a proposed merchant→category mapping. */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authorizeReportsRequest } from "@/lib/reportsAdminAuth";
import { getValidLeafSet } from "@/lib/reportCategories";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authorizeReportsRequest(req);
  if (auth instanceof NextResponse) return auth;

  const { id } = await ctx.params;
  let body: { approved?: unknown; category?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "בקשה לא תקינה" }, { status: 400 });
  }

  const mapping = await db.merchantMapping.findUnique({ where: { id } });
  if (!mapping) return NextResponse.json({ error: "המיפוי לא נמצא" }, { status: 404 });

  const category =
    typeof body.category === "string" && body.category ? body.category : mapping.category;
  if (!(await getValidLeafSet()).has(category)) {
    return NextResponse.json({ error: "קטגוריה לא מוכרת" }, { status: 400 });
  }

  await db.merchantMapping.update({
    where: { id },
    data: { approved: body.approved === true, category },
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authorizeReportsRequest(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await ctx.params;
  await db.merchantMapping.delete({ where: { id } }).catch(() => null);
  return NextResponse.json({ ok: true });
}
