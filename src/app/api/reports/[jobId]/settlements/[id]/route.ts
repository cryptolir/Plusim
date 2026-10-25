/**
 * Client write: match a bank card-settlement debit to one of the job's card
 * charge cycles (docs/plans/bank-statements.md B4). PATCH body
 * `{ matchedCycle: string | null }`.
 *
 * One read for the allow-list — the published job's stored verification, which
 * carries every card source's chargeCycles — then ONE conditional write bound
 * on every identity at once: the settlement id, its job, that job's owner and
 * its published status (the admin edit route's write-side `where: { job: … }`
 * shape). `count === 0` is "not found", whatever the reason: the route never
 * answers with a forbidden status, so it cannot be used to probe other users' jobs.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/db";
import { allowedMatchTargets } from "@/lib/reportAnalysis";

export const dynamic = "force-dynamic";

const NOT_FOUND = () => NextResponse.json({ error: "הדוח לא נמצא" }, { status: 404 });

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ jobId: string; id: string }> }) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "נדרשת התחברות" }, { status: 401 });

  const { jobId, id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "בקשה לא תקינה" }, { status: 400 });
  }
  // A JSON primitive (`null`, `"x"`, `5`) parses fine but is not a body.
  if (typeof body !== "object" || body === null || Array.isArray(body) || !("matchedCycle" in body)) {
    return NextResponse.json({ error: "בקשה לא תקינה" }, { status: 400 });
  }
  const raw = (body as { matchedCycle: unknown }).matchedCycle;
  if (raw !== null && typeof raw !== "string") {
    return NextResponse.json({ error: "בקשה לא תקינה" }, { status: 400 });
  }
  const matchedCycle = raw;

  const job = await db.reportJob.findFirst({
    where: { id: jobId, targetUserId: userId, status: "published" },
    select: { verification: true },
  });
  if (!job) return NOT_FOUND();

  // Fail closed: a cycle id the job's verification does not list is rejected,
  // and a verification without cycles allows nothing but clearing.
  if (matchedCycle !== null && !allowedMatchTargets(job.verification).includes(matchedCycle)) {
    return NextResponse.json({ error: "מחזור חיוב לא קיים בדוח זה" }, { status: 400 });
  }

  const upd = await db.reportSettlement.updateMany({
    where: { id, jobId, job: { targetUserId: userId, status: "published" } },
    data: { matchedCycle },
  });
  if (upd.count === 0) return NOT_FOUND();

  return NextResponse.json({ ok: true, matchedCycle });
}
