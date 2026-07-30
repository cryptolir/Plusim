/**
 * Dispatch a report job to the onlyclaw agent.
 *
 * Mints a fresh per-job token, then sends a compact chat message (well under
 * the 3000-char AgentGlob cap) whose only payload is the manifest URL. The run
 * uses an isolated session (app:plusim:report-job:<jobId>, no appUserId) so no
 * per-user memory is touched — the lesson from the Drive-summarize path.
 *
 * A client-side timeout does NOT abort the agent run (documented AgentGlob
 * behavior): on timeout we leave status=processing and let the result callback
 * finish the job. Re-dispatch is always safe — it re-mints the token.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authorizeReportsRequest } from "@/lib/reportsAdminAuth";
import { mintJobToken, appBaseUrl } from "@/lib/agentRuntimeAuth";
import { callAgent } from "@/lib/agentglob";

export const dynamic = "force-dynamic";
export const maxDuration = 320;

const DISPATCH_TIMEOUT_MS = 300_000;

export async function POST(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const auth = await authorizeReportsRequest(req);
  if (auth instanceof NextResponse) return auth;

  const { jobId } = await ctx.params;
  const job = await db.reportJob.findUnique({
    where: { id: jobId },
    select: { id: true, status: true, _count: { select: { files: true } } },
  });
  if (!job) return NextResponse.json({ error: "העבודה לא נמצאה" }, { status: 404 });
  // A published job may be re-run to absorb newly appended statements, but only
  // deliberately: the caller must opt in with {"confirmUpdate":true}. Without the
  // flag the old refusal stands, so no accidental or legacy call can pull a live
  // report out of the client's view. The job LEAVES `published` until the admin
  // re-publishes; publishedAt + sheetUrl are kept (history + in-place re-export).
  if (job.status === "published") {
    const body = await req.json().catch(() => null);
    const confirmed =
      body !== null && typeof body === "object" && (body as { confirmUpdate?: unknown }).confirmUpdate === true;
    if (!confirmed) {
      return NextResponse.json({ error: "העבודה כבר פורסמה — אשרו עדכון כדי להריץ מחדש" }, { status: 409 });
    }
  }
  if (job._count.files === 0) {
    return NextResponse.json({ error: "לעבודה אין דפי חשבון" }, { status: 400 });
  }

  const { token, tokenHash, expiresAt } = mintJobToken();
  await db.reportJob.update({
    where: { id: jobId },
    data: {
      status: "dispatched",
      dispatchedAt: new Date(),
      error: null,
      agentTokenHash: tokenHash,
      agentTokenExpiresAt: expiresAt,
    },
  });

  const manifestUrl = `${appBaseUrl()}/api/agent/jobs/${jobId}/manifest?t=${encodeURIComponent(token)}`;
  const message = `PLUSIM_REPORT_JOB v1\njob: ${jobId}\nmanifest: ${manifestUrl}`;

  console.log(`[admin/reports] dispatching job=${jobId} by=${auth.actor}`);
  try {
    await db.reportJob.update({ where: { id: jobId }, data: { status: "processing" } });
    const { reply } = await callAgent({
      sessionKey: `app:plusim:report-job:${jobId}`,
      message,
      timeoutMs: DISPATCH_TIMEOUT_MS,
    });
    console.log(`[admin/reports] job=${jobId} agent replied: ${reply.slice(0, 200)}`);
    // The callback (not this reply) is authoritative; report current status.
    const fresh = await db.reportJob.findUnique({ where: { id: jobId }, select: { status: true } });
    return NextResponse.json({ ok: true, status: fresh?.status ?? "processing", agentReply: reply.slice(0, 500) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const timedOut = /abort|timeout/i.test(msg);
    if (timedOut) {
      // Run continues server-side; the callback will complete the job.
      console.warn(`[admin/reports] job=${jobId} dispatch wait timed out; awaiting callback`);
      return NextResponse.json({ ok: true, status: "processing", note: "agent still running; callback will complete the job" });
    }
    console.error(`[admin/reports] job=${jobId} dispatch failed: ${msg}`);
    await db.reportJob.update({
      where: { id: jobId },
      data: { status: "failed", error: `השליחה לסוכן נכשלה: ${msg.slice(0, 500)}` },
    });
    return NextResponse.json({ error: `השליחה לסוכן נכשלה: ${msg}` }, { status: 502 });
  }
}
