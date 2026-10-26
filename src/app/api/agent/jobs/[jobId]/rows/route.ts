/**
 * Agent read of a job's current rows for the adjustment chat.
 * GET /api/agent/jobs/:jobId/rows?t=<adjust token>
 *
 * Auth: static runtime bearer + the per-TURN adjust token, bound to the job's
 * current dispatch generation (authorizeAdjustRequest). Middleware-public
 * (src/proxy.ts) — the handler is the security boundary.
 * docs/plans/report-adjust-chat.md B5.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authorizeAdjustRequest } from "@/lib/agentRuntimeAuth";
import { getMergedTaxonomy } from "@/lib/reportCategories";

export const dynamic = "force-dynamic";

const MAX_ROWS = 5000;

export async function GET(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await ctx.params;
  const auth = await authorizeAdjustRequest(req, jobId);
  if (auth instanceof NextResponse) return auth;

  const transactions = await db.reportTransaction.findMany({
    where: { jobId },
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
      kind: true,
      dedupKey: true,
    },
    orderBy: [{ month: "asc" }, { date: "asc" }, { id: "asc" }],
    take: MAX_ROWS,
  });
  return NextResponse.json({
    job: { id: auth.job.id, status: auth.job.status },
    taxonomy: await getMergedTaxonomy(),
    transactions,
  });
}
