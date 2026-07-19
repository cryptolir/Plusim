/**
 * Agent result callback. POST /api/agent/jobs/:jobId/result?t=…
 *
 * Stores what the agent produced, then independently re-verifies it
 * (src/lib/reportResult.ts). Verification failure — or an agent-declared
 * needs_review — parks the job at needs_review instead of completed; the data
 * is stored either way so the admin can inspect it. Idempotent-ish: a repeat
 * callback for the same job replaces previous transactions/artifacts.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authorizeAgentJobRequest } from "@/lib/agentRuntimeAuth";
import { parseAgentResult, verifyAgentResult, decodeXlsx } from "@/lib/reportResult";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await ctx.params;
  const auth = await authorizeAgentJobRequest(req, jobId);
  if (auth instanceof NextResponse) return auth;

  if (["published"].includes(auth.job.status)) {
    return NextResponse.json({ error: "job already published" }, { status: 409 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  try {
    const result = parseAgentResult(body);
    const verification = verifyAgentResult(result);
    const xlsx = decodeXlsx(result.xlsxBase64);

    const completedOk = result.status === "ok" && verification.ok;
    const status = completedOk ? "completed" : "needs_review";

    await db.$transaction([
      db.reportTransaction.deleteMany({ where: { jobId } }),
      db.reportArtifact.deleteMany({ where: { jobId } }),
      db.reportTransaction.createMany({
        data: result.transactions.map((t) => ({
          jobId,
          month: t.month,
          date: t.date,
          merchant: t.merchant,
          amountAgorot: t.amountAgorot,
          category: t.category,
          uncategorized: t.uncategorized,
          sourceLabel: t.sourceLabel,
          note: t.note ?? null,
          dedupKey: t.dedupKey,
        })),
      }),
      db.reportArtifact.create({
        data: {
          jobId,
          kind: "xlsx",
          filename: result.xlsxFilename ?? `plusim-report-${jobId}.xlsx`,
          bytes: xlsx,
        },
      }),
      db.reportJob.update({
        where: { id: jobId },
        data: {
          status,
          completedAt: new Date(),
          error: null,
          verification: {
            agentStatus: result.status,
            agentNotes: result.agentNotes ?? null,
            ...verification,
          },
        },
      }),
    ]);

    // Proposed mappings arrive unapproved; the admin promotes them in review.
    for (const m of result.proposedMappings.slice(0, 200)) {
      await db.merchantMapping.upsert({
        where: { merchantPattern: m.merchant },
        create: { merchantPattern: m.merchant, category: m.category, source: "agent", approved: false, hitCount: 1 },
        update: { hitCount: { increment: 1 } },
      });
    }

    console.log(
      `[agent/result] job=${jobId} status=${status} tx=${verification.txCount} uncat=${verification.uncategorizedCount} problems=${verification.problems.length}`,
    );
    return NextResponse.json({ ok: true, status, problems: verification.problems });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[agent/result] job=${jobId} rejected: ${msg}`);
    await db.reportJob.update({
      where: { id: jobId },
      data: { status: "needs_review", error: `result rejected: ${msg}` },
    });
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
