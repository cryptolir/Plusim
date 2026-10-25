/**
 * Reports admin API — review a single transaction: assign a category to an
 * uncategorized row (or recategorize), and/or correct its date. Optionally
 * remembers the merchant as an approved MerchantMapping for future jobs.
 *
 * Every write here is CONDITIONAL on the parent job not being mid-run. The
 * result callback deletes and recreates every transaction row of a job
 * (api/agent/jobs/[jobId]/result/route.ts:73-88), so an edit accepted while the
 * agent is working reports success and is then silently erased. Checking the
 * status first and updating second still loses that race — the run route can
 * flip the job to `dispatched` in between — so the status test lives inside the
 * update's own `where`, and `count === 0` is the rejection (same count-CAS the
 * result route uses). This covers category assignment too: that race predates
 * the date feature and is fixed here at the shared write.
 *
 * EXACT boundary this makes, and the one it does not:
 *   - guaranteed: no edit lands on a job that is ALREADY dispatched/processing.
 *   - NOT guaranteed: that an accepted edit survives a re-run started later.
 *
 * ponytail: the second is deliberate, not an oversight. A re-run rebuilds every
 * row from the statements, so it discards manual dates and unremembered
 * categories BY DESIGN — the confirm dialog and ADMIN_GUIDE both say so. The
 * relation predicate reads the parent at this statement's snapshot and does not
 * lock it, so a run CASing to `dispatched` immediately after this commit still
 * erases the edit (Codex, PR #48). Serializing the two with a row lock or a
 * shared generation guard would only ORDER them — the run would acquire the
 * lock next and wipe the row anyway — so it buys ordering, not survival, at the
 * cost of coupling two routes. Closing it for real means PRESERVING admin edits
 * across a re-run (re-applying them after the agent's rebuild), which is a
 * feature the plan explicitly deferred, not a lock. Until then the window is
 * milliseconds wide and its outcome is identical to the documented case of
 * editing a minute before clicking re-run.
 */
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { authorizeReportsRequest } from "@/lib/reportsAdminAuth";
import { getMergedTaxonomy, getValidLeafSet } from "@/lib/reportCategories";
import { isIncomeLeaf, type TxnKind } from "@/config/reportTaxonomy";

export const dynamic = "force-dynamic";

/** Statuses during which the agent owns the transaction rows. */
const AGENT_OWNS_ROWS = ["dispatched", "processing"];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A calendar date, or null. The shape test alone accepts 2026-02-31, which
 * Date() silently rolls forward to March 3 — so the parsed value must render
 * back to the same string. Exported for direct testing.
 */
export function normalizeDate(raw: unknown): string | null {
  if (typeof raw !== "string" || !DATE_RE.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10) === raw ? raw : null;
}

/**
 * A row's source is a bank account when the stored verification reports no
 * printed statement total for it — the same criterion verifyAgentResult uses.
 * Fails closed: no verification, or a label it does not list, is not a bank.
 */
function isBankSource(sourceLabel: string, verification: unknown): boolean {
  if (typeof verification !== "object" || verification === null) return false;
  const per = (verification as { perSource?: unknown }).perSource;
  if (!Array.isArray(per)) return false;
  return per.some(
    (s) =>
      typeof s === "object" && s !== null &&
      (s as { label?: unknown }).label === sourceLabel &&
      (s as { statementTotalAgorot?: unknown }).statementTotalAgorot === null,
  );
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ jobId: string; txId: string }> },
) {
  const auth = await authorizeReportsRequest(req);
  if (auth instanceof NextResponse) return auth;

  const { jobId, txId } = await ctx.params;
  let body: { category?: unknown; rememberMerchant?: unknown; date?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "בקשה לא תקינה" }, { status: 400 });
  }

  const wantsCategory = body.category !== undefined;
  const wantsDate = body.date !== undefined;
  if (!wantsCategory && !wantsDate) {
    return NextResponse.json({ error: "לא נשלח שינוי" }, { status: 400 });
  }

  // Each field validates independently, and only the fields actually sent are
  // written: a date-only edit must never mark a row categorized, and a
  // category-only edit must never touch the date.
  const data: { category?: string; uncategorized?: boolean; date?: string; month?: string; kind?: TxnKind } = {};

  let category = "";
  let incomeLeaf = false;
  if (wantsCategory) {
    category = typeof body.category === "string" ? body.category : "";
    if (!(await getValidLeafSet()).has(category)) {
      return NextResponse.json({ error: "קטגוריה לא מוכרת" }, { status: 400 });
    }
    // Income invariant (docs/plans/bank-statements.md B5): an הכנסות leaf makes
    // the row income and is allowed only on a bank credit (negative amount from
    // a source with no printed total); any other leaf makes it an expense — for
    // a credit that is a refund. The kind is written in the SAME update as the
    // category so the two can never diverge (verification treats a mismatch as
    // fatal). The pre-read is for validation only; the write below is still the
    // one conditional statement.
    incomeLeaf = isIncomeLeaf(category, await getMergedTaxonomy());
    if (incomeLeaf) {
      const row = await db.reportTransaction.findFirst({
        where: { id: txId, jobId },
        select: { amountAgorot: true, sourceLabel: true, job: { select: { verification: true } } },
      });
      if (!row) return NextResponse.json({ error: "העסקה לא נמצאה" }, { status: 404 });
      if (row.amountAgorot >= 0) {
        return NextResponse.json({ error: "קטגוריית הכנסה אפשרית רק לזיכוי (סכום שלילי)" }, { status: 400 });
      }
      if (!isBankSource(row.sourceLabel, row.job.verification)) {
        return NextResponse.json({ error: "קטגוריית הכנסה אפשרית רק לשורה מחשבון בנק" }, { status: 400 });
      }
    }
    data.category = category;
    data.uncategorized = false;
    data.kind = incomeLeaf ? "income" : "expense";
  }

  if (wantsDate) {
    const date = normalizeDate(body.date);
    if (!date) {
      return NextResponse.json({ error: "תאריך לא תקין" }, { status: 400 });
    }
    // month is derived here, in the same write, so the two can never diverge —
    // a mismatch is a FATAL verification problem (reportResult.ts).
    data.date = date;
    data.month = date.slice(0, 7);
  }

  const upd = await db.reportTransaction.updateMany({
    where: { id: txId, jobId, job: { status: { notIn: AGENT_OWNS_ROWS } } },
    data,
  });

  if (upd.count === 0) {
    // Nothing was written. Re-read only to tell "gone" from "mid-run" for the
    // error message — the refusal already happened, atomically, above.
    const tx = await db.reportTransaction.findFirst({
      where: { id: txId, jobId },
      select: { job: { select: { status: true } } },
    });
    if (!tx) return NextResponse.json({ error: "העסקה לא נמצאה" }, { status: 404 });
    return NextResponse.json(
      { error: "הסוכן עובד על העבודה הזו — השינוי יימחק בסיום ההרצה; המתינו לסיום ונסו שוב" },
      { status: 409 },
    );
  }

  // Only after a write that actually landed, and only for an EXPENSE category
  // edit: the dictionary holds one direction per merchant, so an income leaf
  // (or a refund decision on a credit) is never remembered.
  if (wantsCategory && body.rememberMerchant === true && !incomeLeaf) {
    const tx = await db.reportTransaction.findFirst({
      where: { id: txId, jobId },
      select: { merchant: true, amountAgorot: true },
    });
    // A negative row that just took an expense leaf is a refund credit — its
    // merchant's dictionary entry (if any) describes the DEBIT direction.
    if (tx && tx.amountAgorot >= 0) {
      await db.merchantMapping.upsert({
        where: { merchantPattern: tx.merchant },
        create: { merchantPattern: tx.merchant, category, source: "admin", approved: true },
        update: { category, approved: true, source: "admin" },
      });
    }
  }

  return NextResponse.json({ ok: true });
}
