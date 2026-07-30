/** Reports admin API — job detail (files, verification, transactions, pending mappings). */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authorizeReportsRequest } from "@/lib/reportsAdminAuth";
import { getMergedTaxonomy } from "@/lib/reportCategories";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const auth = await authorizeReportsRequest(req);
  if (auth instanceof NextResponse) return auth;

  const { jobId } = await ctx.params;
  const job = await db.reportJob.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      targetUserId: true,
      createdBy: true,
      status: true,
      title: true,
      error: true,
      verification: true,
      sheetUrl: true,
      createdAt: true,
      dispatchedAt: true,
      completedAt: true,
      publishedAt: true,
      files: { select: { id: true, filename: true, mime: true, size: true, sourceLabel: true } },
      artifacts: { select: { id: true, filename: true, createdAt: true } },
      transactions: {
        orderBy: [{ month: "asc" }, { date: "asc" }],
        select: {
          id: true,
          month: true,
          date: true,
          merchant: true,
          amountAgorot: true,
          category: true,
          uncategorized: true,
          sourceLabel: true,
          note: true,
        },
      },
    },
  });
  if (!job) return NextResponse.json({ error: "העבודה לא נמצאה" }, { status: 404 });

  const pendingMappings = await db.merchantMapping.findMany({
    where: { approved: false },
    orderBy: { updatedAt: "desc" },
    take: 100,
    select: { id: true, merchantPattern: true, category: true, source: true },
  });

  // Merged (base ∪ ReportCategory) leaves in section order — the assign
  // picker renders from this, never from the static base constant.
  const categoryLeaves = (await getMergedTaxonomy()).flatMap((s) => s.leaves);

  return NextResponse.json({ job, pendingMappings, categoryLeaves });
}
