/**
 * Enqueue a report job for dispatch to the onlyclaw agent.
 *
 * This route no longer calls the agent (docs/plans/reports-scaling-stage1-2.md
 * §3): it CASes the job to `dispatched`, enqueues a pg-boss entry carrying the
 * generation key, and returns 202. The worker (src/worker) claims the entry,
 * mints the per-job token — so the 24h TTL starts at actual dispatch, not
 * enqueue — and holds the callAgent call.
 *
 * The status write is a CAS conditioned on the status this request is entitled
 * to leave, so a concurrent double-POST loses before any queue write (F7). It
 * clears agentTokenHash, so a delayed callback from the previous run no-matches
 * the result route's acceptingWhere while the new run is queued (F8), and
 * clears error so a rerun from `failed` doesn't show the stale failure (F12).
 *
 * A send failure reverts — conditionally, bound to this exact dispatch
 * generation (F11), restoring the full pre-CAS snapshot {status, dispatchedAt,
 * error} so the publish route's dispatch-watermark guards never see the aborted
 * generation (F20). Residual double-fault (send threw AND revert lost): the job
 * sits in `dispatched` with queueJobId=null — visibly stale after 2 minutes,
 * when the CAS accepts it again (F1).
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authorizeReportsRequest } from "@/lib/reportsAdminAuth";
import { sendReportDispatch } from "@/lib/reportQueue";

export const dynamic = "force-dynamic";

/** Statuses a plain run may leave; `published` needs {"confirmUpdate":true}. */
const DISPATCHABLE = ["uploaded", "completed", "needs_review", "failed"];
const STALE_DISPATCH_MS = 2 * 60_000;

export async function POST(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const auth = await authorizeReportsRequest(req);
  if (auth instanceof NextResponse) return auth;

  const { jobId } = await ctx.params;
  // Pre-guard read; the select is also the pre-CAS snapshot the revert restores.
  const job = await db.reportJob.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      status: true,
      dispatchedAt: true,
      error: true,
      _count: { select: { files: true } },
    },
  });
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  // A published job may be re-run to absorb newly appended statements, but only
  // deliberately: the caller must opt in with {"confirmUpdate":true}. Without the
  // flag the old refusal stands, so no accidental or legacy call can pull a live
  // report out of the client's view. The job LEAVES `published` until the admin
  // re-publishes; publishedAt + sheetUrl are kept (history + in-place re-export).
  let confirmedUpdate = false;
  if (job.status === "published") {
    const body = await req.json().catch(() => null);
    confirmedUpdate =
      body !== null && typeof body === "object" && (body as { confirmUpdate?: unknown }).confirmUpdate === true;
    if (!confirmedUpdate) {
      return NextResponse.json({ error: "job already published" }, { status: 409 });
    }
  }
  if (job._count.files === 0) {
    return NextResponse.json({ error: "job has no statement files" }, { status: 400 });
  }

  const now = new Date();
  const cas = await db.reportJob.updateMany({
    where: {
      id: jobId,
      OR: [
        { status: { in: confirmedUpdate ? [...DISPATCHABLE, "published"] : DISPATCHABLE } },
        // Double-fault recovery (F1): a dispatched row whose enqueue died before
        // writing a queue entry is reclaimable once it is VISIBLY stale; a fresh
        // dispatch (or one a worker claimed — queueJobId set) is not.
        {
          status: "dispatched",
          queueJobId: null,
          dispatchedAt: { lt: new Date(now.getTime() - STALE_DISPATCH_MS) },
        },
      ],
    },
    data: {
      status: "dispatched",
      dispatchedAt: now,
      error: null,
      agentTokenHash: null,
      agentTokenExpiresAt: null,
      queueJobId: null,
    },
  });
  if (cas.count === 0) {
    return NextResponse.json({ error: "dispatch already in flight or state changed" }, { status: 409 });
  }

  console.log(`[admin/reports] enqueueing job=${jobId} by=${auth.actor} gen=${now.toISOString()}`);
  try {
    await sendReportDispatch({ jobId, gen: now.toISOString() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[admin/reports] job=${jobId} enqueue failed: ${msg}`);
    // Revert only a row this generation still owns — pristine (no claim, no
    // token) and carrying OUR dispatchedAt. A second request that stale-reclaimed
    // in the meantime rewrote dispatchedAt, so this no-matches it (F11). Token
    // fields stay null: no new run exists to authenticate (fail closed).
    await db.reportJob.updateMany({
      where: {
        id: jobId,
        status: "dispatched",
        queueJobId: null,
        agentTokenHash: null,
        dispatchedAt: now,
      },
      data: { status: job.status, dispatchedAt: job.dispatchedAt, error: job.error },
    });
    return NextResponse.json({ error: `enqueue failed: ${msg.slice(0, 500)}` }, { status: 502 });
  }
  return NextResponse.json({ ok: true, status: "dispatched" }, { status: 202 });
}
