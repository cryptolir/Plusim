/**
 * Agent-facing job manifest. GET /api/agent/jobs/:jobId/manifest?t=<jobToken>
 * Auth: static runtime bearer + per-job token (agentRuntimeAuth) — this route
 * is middleware-public (src/proxy.ts), the handler is the security boundary.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authorizeAgentJobRequest, appBaseUrl } from "@/lib/agentRuntimeAuth";
import { REPORT_TAXONOMY } from "@/config/reportTaxonomy";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await ctx.params;
  const auth = await authorizeAgentJobRequest(req, jobId);
  if (auth instanceof NextResponse) return auth;

  const t = new URL(req.url).searchParams.get("t") ?? "";
  const files = await db.statementFile.findMany({
    where: { jobId },
    select: { id: true, filename: true, mime: true, size: true, sourceLabel: true },
    orderBy: { createdAt: "asc" },
  });
  const dictionary = await db.merchantMapping.findMany({
    where: { approved: true },
    select: { merchantPattern: true, category: true },
    orderBy: { updatedAt: "desc" },
    take: 2000,
  });

  const base = appBaseUrl();
  const q = `?t=${encodeURIComponent(t)}`;
  return NextResponse.json({
    version: 1,
    job: { id: jobId, status: auth.job.status },
    files: files.map((f) => ({
      id: f.id,
      name: f.filename,
      mime: f.mime,
      size: f.size,
      sourceLabel: f.sourceLabel,
      url: `${base}/api/agent/jobs/${jobId}/files/${f.id}${q}`,
    })),
    taxonomy: REPORT_TAXONOMY,
    merchantDictionary: dictionary,
    callback: { resultUrl: `${base}/api/agent/jobs/${jobId}/result${q}` },
    constraints: {
      monthAssignment: "calendar month of the transaction date, never the billing month",
      amounts: "actual charge amount in agorot (integer); credits/cancellations negative",
      uncategorizedPolicy: "never guess — unidentifiable merchants go to un_categorized with a reason",
      dedup: "pending-vs-billed and cross-source duplicates must be removed (voucher id or date|merchant|amount)",
    },
  });
}
