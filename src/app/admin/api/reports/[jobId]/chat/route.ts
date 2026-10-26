/**
 * The admin "שיחה עם הסוכן" tab of a report (docs/plans/report-adjust-chat.md B4).
 *
 * POST { message } — relays the admin's request to onlyclaw with a per-TURN
 * adjust token in the message. The token is minted and claimed in ONE
 * conditional write (one live token per job; bound to the job's current
 * dispatch generation) and cleared in `finally` whatever happens, so an agent
 * transcript only ever holds a dead token. The agent's power through it is
 * exactly date / category edits on this job's rows (api/agent/jobs/[jobId]/adjust).
 *
 * GET — the thread for the job's CURRENT generation, in the shape the chat
 * runtime's pending-reply pickup consumes ({ messages, serverNow }).
 *
 * Admin-only (authorizeReportsRequest). The agent session is isolated and
 * stateless per generation, with no appUserId — like report-job dispatch.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authorizeReportsRequest } from "@/lib/reportsAdminAuth";
import { rateLimit } from "@/lib/ratelimit";
import { callAgent } from "@/lib/agentglob";
import { AGENT_TIMEOUT_MS } from "@/lib/chatTimeouts";
import { appBaseUrl, mintAdjustToken } from "@/lib/agentRuntimeAuth";
import { ADJUSTABLE } from "@/lib/reportEdits";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_MESSAGE_LENGTH = 2000;

export function adjustSessionKey(jobId: string, generation: Date): string {
  return `app:plusim:report-adjust:${jobId}:${generation.toISOString()}`;
}

export function adjustMessage(jobId: string, token: string, text: string): string {
  const base = `${appBaseUrl()}/api/agent/jobs/${jobId}`;
  const q = `?t=${encodeURIComponent(token)}`;
  return [
    "PLUSIM_REPORT_ADJUST v1",
    `job: ${jobId}`,
    `rows: ${base}/rows${q}`,
    `adjust: ${base}/adjust${q}`,
    "<<<admin>>>",
    text,
    "<<<end_admin>>>",
  ].join("\n");
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const auth = await authorizeReportsRequest(req);
  if (auth instanceof NextResponse) return auth;

  const rl = rateLimit(`report-adjust:${auth.actor}`);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "יותר מדי הודעות — המתינו רגע ונסו שוב" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter ?? 60) } },
    );
  }

  const { jobId } = await ctx.params;
  let body: { message?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "בקשה לא תקינה" }, { status: 400 });
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message || message.length > MAX_MESSAGE_LENGTH) {
    return NextResponse.json({ error: `ההודעה ריקה או ארוכה מ־${MAX_MESSAGE_LENGTH} תווים` }, { status: 400 });
  }

  const job = await db.reportJob.findUnique({ where: { id: jobId }, select: { status: true, dispatchedAt: true } });
  if (!job) return NextResponse.json({ error: "העבודה לא נמצאה" }, { status: 404 });
  if (!ADJUSTABLE.includes(job.status) || !job.dispatchedAt) {
    return NextResponse.json({ error: "אפשר לשוחח עם הסוכן רק על דוח שהעיבוד שלו הסתיים" }, { status: 409 });
  }
  const generation = job.dispatchedAt;

  // Mint + claim in ONE conditional write: one live token per job, and only for
  // the generation read above — a re-run in between makes this miss.
  const now = new Date();
  const minted = mintAdjustToken();
  const claim = await db.reportJob.updateMany({
    where: {
      id: jobId,
      status: { in: ADJUSTABLE },
      dispatchedAt: generation,
      OR: [{ adjustTokenHash: null }, { adjustTokenExpiresAt: { lt: now } }],
    },
    data: { adjustTokenHash: minted.tokenHash, adjustTokenExpiresAt: minted.expiresAt, adjustGeneration: generation },
  });
  if (claim.count === 0) {
    return NextResponse.json({ error: "הסוכן עדיין עובד על בקשה קודמת — המתינו לתשובה ונסו שוב" }, { status: 409 });
  }

  try {
    const userMessage = await db.reportChatMessage.create({
      data: { jobId, role: "user", content: message, actor: auth.actor, generation },
    });
    let reply: string;
    try {
      reply = (
        await callAgent({
          sessionKey: adjustSessionKey(jobId, generation),
          message: adjustMessage(jobId, minted.token, message),
          timeoutMs: AGENT_TIMEOUT_MS,
        })
      ).reply;
    } catch (e) {
      console.error(`[admin/report-chat] job=${jobId} agent error: ${e instanceof Error ? e.message : String(e)}`);
      return NextResponse.json(
        { error: "הסוכן לא ענה. ייתכן ששינויים כבר נשמרו — רעננו את הדף לפני שתנסו שוב" },
        { status: 502 },
      );
    }
    // Filed under the generation the turn was minted for, even if a re-run
    // landed meanwhile — the new thread never shows it (Codex P2, Rev 3).
    const assistantMessage = await db.reportChatMessage.create({
      data: { jobId, role: "assistant", content: reply, generation },
    });
    console.log(`[admin/report-chat] job=${jobId} by=${auth.actor} replied`);
    return NextResponse.json({ conversationId: jobId, userMessage, assistantMessage });
  } finally {
    await db.reportJob.updateMany({
      where: { id: jobId, adjustTokenHash: minted.tokenHash },
      data: { adjustTokenHash: null, adjustTokenExpiresAt: null, adjustGeneration: null },
    });
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const auth = await authorizeReportsRequest(req);
  if (auth instanceof NextResponse) return auth;

  const { jobId } = await ctx.params;
  const job = await db.reportJob.findUnique({ where: { id: jobId }, select: { dispatchedAt: true } });
  if (!job) return NextResponse.json({ error: "העבודה לא נמצאה" }, { status: 404 });

  const messages = job.dispatchedAt
    ? await db.reportChatMessage.findMany({
        where: { jobId, generation: job.dispatchedAt },
        select: { id: true, role: true, content: true, createdAt: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    : [];
  return NextResponse.json({ messages, serverNow: new Date().toISOString() });
}
