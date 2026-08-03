/**
 * Agent result callback. POST /api/agent/jobs/:jobId/result?t=…
 *
 * Stores what the agent produced, then independently re-verifies it
 * (src/lib/reportResult.ts). Integrity failure (fatal) — or an agent-declared
 * needs_review — parks the job at needs_review instead of completed; the data is
 * stored either way so the admin can inspect it.
 *
 * The persistence is one interactive transaction whose job update is CONDITIONAL
 * on the job still accepting results — status in (dispatched|processing) AND the
 * exact token hash that authorized this call. 0 rows ⇒ the job was published or
 * re-dispatched in the meantime ⇒ 409 and NOTHING is written (Rev 2 — Codex P1
 * publish/result race).
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authorizeAgentJobRequest } from "@/lib/agentRuntimeAuth";
import { parseAgentResult, verifyAgentResult, decodeXlsx, rejectionHe } from "@/lib/reportResult";
import { getValidLeafSet } from "@/lib/reportCategories";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

class JobClosedError extends Error {}

export async function POST(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await ctx.params;
  const auth = await authorizeAgentJobRequest(req, jobId);
  if (auth instanceof NextResponse) return auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  // Only a job still accepting results, keyed on the authorizing token hash.
  const acceptingWhere = {
    id: jobId,
    status: { in: ["dispatched", "processing"] },
    agentTokenHash: auth.tokenHash,
  };

  try {
    // The merged (base ∪ ReportCategory) leaf set — read at callback time, so a
    // superset of whatever taxonomy the manifest served earlier (add-only).
    const validLeaves = await getValidLeafSet();
    const result = parseAgentResult(body, validLeaves);
    const verification = verifyAgentResult(result, validLeaves);
    const xlsx = decodeXlsx(result.xlsxBase64);

    const completedOk = result.status === "ok" && !verification.fatal;
    const status = completedOk ? "completed" : "needs_review";

    try {
      await db.$transaction(async (tx) => {
        const upd = await tx.reportJob.updateMany({
          where: acceptingWhere,
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
        });
        if (upd.count === 0) throw new JobClosedError();

        await tx.reportTransaction.deleteMany({ where: { jobId } });
        await tx.reportArtifact.deleteMany({ where: { jobId } });
        await tx.reportTransaction.createMany({
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
        });
        await tx.reportArtifact.create({
          data: {
            jobId,
            filename: result.xlsxFilename ?? `plusim-report-${jobId}.xlsx`,
            bytes: xlsx,
          },
        });
      });
    } catch (e) {
      if (e instanceof JobClosedError) {
        return NextResponse.json({ error: "job no longer accepting results" }, { status: 409 });
      }
      throw e;
    }

    // Proposed mappings arrive unapproved; the admin promotes them in review.
    // upsert only ensures the row exists — never clobbers an admin's category/approval.
    // Best-effort AFTER the job is committed: a mapping hiccup must not demote the
    // stored report (so it runs outside the outer try's error handling).
    try {
      for (const m of result.proposedMappings.slice(0, 200)) {
        await db.merchantMapping.upsert({
          where: { merchantPattern: m.merchant },
          create: { merchantPattern: m.merchant, category: m.category, source: "agent", approved: false },
          update: {},
        });
      }
    } catch (e) {
      console.error(`[agent/result] job=${jobId} mapping upsert failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    }

    console.log(
      `[agent/result] job=${jobId} status=${status} fatal=${verification.fatal} tx=${verification.txCount} uncat=${verification.uncategorizedCount} problems=${verification.problems.length}`,
    );
    return NextResponse.json({ ok: true, status, fatal: verification.fatal, problems: verification.problems });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[agent/result] job=${jobId} rejected: ${msg}`);
    // Conditional even on the error path — never clobber a job that was published
    // or re-dispatched between auth and here.
    await db.reportJob.updateMany({
      where: acceptingWhere,
      data: { status: "needs_review", error: rejectionHe(msg).slice(0, 500) },
    });
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
