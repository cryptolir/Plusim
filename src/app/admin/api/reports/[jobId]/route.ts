/** Reports admin API — job detail (files, verification, transactions, pending mappings) + delete. */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authorizeReportsRequest } from "@/lib/reportsAdminAuth";
import { getMergedTaxonomy } from "@/lib/reportCategories";
import { trashFile } from "@/lib/googleDrive";

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

/**
 * Delete an entire report and everything under it (files, transactions,
 * artifacts cascade via the schema's onDelete: Cascade). Drive trash is
 * best-effort, same as the per-file delete route — the DB row is the source
 * of truth and a Drive hiccup must not block the deletion.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const auth = await authorizeReportsRequest(req);
  if (auth instanceof NextResponse) return auth;

  const { jobId } = await ctx.params;
  const job = await db.reportJob.findUnique({
    where: { id: jobId },
    select: { id: true, status: true, files: { select: { driveFileId: true } } },
  });
  if (!job) return NextResponse.json({ error: "העבודה לא נמצאה" }, { status: 404 });
  if (["dispatched", "processing"].includes(job.status)) {
    return NextResponse.json(
      { error: "הסוכן עובד על העבודה הזו — יש להמתין לסיום לפני מחיקה" },
      { status: 409 },
    );
  }

  await db.reportJob.delete({ where: { id: jobId } });

  for (const file of job.files) {
    try {
      await trashFile(file.driveFileId);
    } catch (e) {
      console.warn(
        `[admin/reports] job=${jobId} could not trash file ${file.driveFileId} on job delete: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  console.log(`[admin/reports] job=${jobId} deleted by=${auth.actor}`);
  return NextResponse.json({ ok: true });
}
