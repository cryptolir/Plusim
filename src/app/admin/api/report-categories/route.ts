/**
 * Reports admin API — add a custom category leaf (ReportCategory, add-only).
 * The new leaf joins an existing base section and becomes part of the merged
 * taxonomy everywhere (manifest, verification, pickers, /report). Fail closed:
 * bad name/section → 400, collision with a base leaf or existing row → 409.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authorizeReportsRequest } from "@/lib/reportsAdminAuth";
// The ONLY permitted runtime isTaxonomyLeaf call: the base-leaf-collision
// check below. Category *membership* everywhere else uses the merged set.
import { isTaxonomyLeaf, SECTION_NAMES } from "@/config/reportTaxonomy";

export const dynamic = "force-dynamic";

const MAX_NAME = 60;

export async function POST(req: NextRequest) {
  const auth = await authorizeReportsRequest(req);
  if (auth instanceof NextResponse) return auth;

  let body: { name?: unknown; section?: unknown };
  try {
    // A body that parses to null/array/scalar is a bad shape, not a crash:
    // funnel it through the field validation below (→ 400), never a 500.
    const parsed: unknown = await req.json();
    body =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as { name?: unknown; section?: unknown })
        : {};
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const name =
    typeof body.name === "string" ? body.name.normalize("NFKC").replace(/\s+/g, " ").trim() : "";
  if (!name || name.length > MAX_NAME) {
    return NextResponse.json({ error: "שם קטגוריה לא תקין" }, { status: 400 });
  }
  const section = typeof body.section === "string" ? body.section : "";
  if (!SECTION_NAMES.includes(section)) {
    return NextResponse.json({ error: "מדור לא תקין" }, { status: 400 });
  }
  // No shadowing a base leaf, no duplicate row (@unique backstops the race).
  if (isTaxonomyLeaf(name)) {
    return NextResponse.json({ error: "קטגוריה כבר קיימת" }, { status: 409 });
  }
  const existing = await db.reportCategory.findUnique({ where: { name } });
  if (existing) {
    return NextResponse.json({ error: "קטגוריה כבר קיימת" }, { status: 409 });
  }

  let row: { id: string; name: string; section: string };
  try {
    row = await db.reportCategory.create({
      data: { name, section, createdBy: auth.actor },
      select: { id: true, name: true, section: true },
    });
  } catch (e) {
    // Concurrent same-name creates can both pass the pre-check; the loser
    // hits @unique (Prisma P2002) — same 409 contract, not a 500.
    if ((e as { code?: string } | null)?.code === "P2002") {
      return NextResponse.json({ error: "קטגוריה כבר קיימת" }, { status: 409 });
    }
    throw e;
  }
  console.log(`[admin/report-categories] added "${row.name}" (${row.section}) by=${auth.actor}`);
  return NextResponse.json({ ok: true, category: row });
}
