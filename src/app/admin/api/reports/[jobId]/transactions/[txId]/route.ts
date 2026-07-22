/**
 * Reports admin API — review a single transaction: assign a category to an
 * uncategorized row (or recategorize), optionally remembering the merchant as
 * an approved MerchantMapping for future jobs.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authorizeReportsRequest } from "@/lib/reportsAdminAuth";
import { getValidLeafSet } from "@/lib/reportCategories";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ jobId: string; txId: string }> },
) {
  const auth = await authorizeReportsRequest(req);
  if (auth instanceof NextResponse) return auth;

  const { jobId, txId } = await ctx.params;
  let body: { category?: unknown; rememberMerchant?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const category = typeof body.category === "string" ? body.category : "";
  if (!(await getValidLeafSet()).has(category)) {
    return NextResponse.json({ error: "unknown category" }, { status: 400 });
  }

  const tx = await db.reportTransaction.findFirst({ where: { id: txId, jobId } });
  if (!tx) return NextResponse.json({ error: "not found" }, { status: 404 });

  await db.reportTransaction.update({
    where: { id: txId },
    data: { category, uncategorized: false },
  });

  if (body.rememberMerchant === true) {
    await db.merchantMapping.upsert({
      where: { merchantPattern: tx.merchant },
      create: { merchantPattern: tx.merchant, category, source: "admin", approved: true },
      update: { category, approved: true, source: "admin" },
    });
  }

  return NextResponse.json({ ok: true });
}
