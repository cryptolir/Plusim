/**
 * PATCH a transaction — date editing, and the edit/re-run race.
 *
 * Two properties matter here:
 *  1. Field independence — a date-only edit must never mark a row categorized,
 *     and a category-only edit must never touch the date.
 *  2. The write is conditional on the parent job not being mid-run. The result
 *     callback deletes and recreates every row of a job, so an edit accepted
 *     while the agent works is silently erased. A check-then-write guard still
 *     loses that race, so the status test lives in the update's own `where` and
 *     `count === 0` is the rejection.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/reportsAdminAuth", () => ({ authorizeReportsRequest: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    reportTransaction: { updateMany: vi.fn(), findFirst: vi.fn() },
    merchantMapping: { upsert: vi.fn() },
  },
}));
vi.mock("@/lib/reportCategories", () => ({ getValidLeafSet: vi.fn(), getMergedTaxonomy: vi.fn() }));

import { db } from "@/lib/db";
import { authorizeReportsRequest } from "@/lib/reportsAdminAuth";
import { getMergedTaxonomy, getValidLeafSet } from "@/lib/reportCategories";
import { REPORT_TAXONOMY } from "@/config/reportTaxonomy";
import { PATCH, normalizeDate } from "./[jobId]/transactions/[txId]/route";

const auth = authorizeReportsRequest as unknown as ReturnType<typeof vi.fn>;
const updateMany = db.reportTransaction.updateMany as unknown as ReturnType<typeof vi.fn>;
const findFirst = db.reportTransaction.findFirst as unknown as ReturnType<typeof vi.fn>;
const upsert = db.merchantMapping.upsert as unknown as ReturnType<typeof vi.fn>;
const leafSet = getValidLeafSet as unknown as ReturnType<typeof vi.fn>;
const mergedTax = getMergedTaxonomy as unknown as ReturnType<typeof vi.fn>;

const FOOD = "מזון ומכולת";
const SALARY = "משכורת 1";
const BANK_VERIFICATION = {
  perSource: [
    { label: "hapoalim-1812", statementTotalAgorot: null, bank: true },
    { label: "max-1-pending", statementTotalAgorot: null }, // a card source without a total is NOT a bank
    { label: "isracard-4962", statementTotalAgorot: 1579 },
  ],
};
const params = Promise.resolve({ jobId: "jobA", txId: "txA" });
const req = (body: unknown) =>
  new NextRequest("http://localhost/admin/api/reports/jobA/transactions/txA", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ actor: "admin@plusim.xyz" });
  leafSet.mockResolvedValue(new Set([FOOD, SALARY]));
  mergedTax.mockResolvedValue(REPORT_TAXONOMY);
  updateMany.mockResolvedValue({ count: 1 });
  findFirst.mockResolvedValue({ merchant: "יוחננוף", amountAgorot: 1579, job: { status: "completed" } });
  upsert.mockResolvedValue({});
});

describe("normalizeDate", () => {
  it("accepts a real calendar date", () => {
    expect(normalizeDate("2026-05-15")).toBe("2026-05-15");
  });

  // The shape test alone accepts these; Date() rolls them forward silently.
  it("rejects a well-shaped but non-existent date", () => {
    expect(normalizeDate("2026-02-31")).toBeNull();
    expect(normalizeDate("2026-13-01")).toBeNull();
  });

  it("rejects wrong shapes and non-strings", () => {
    for (const bad of ["2026-2-3", "31/05/2026", "", "  ", 20260515, null, undefined]) {
      expect(normalizeDate(bad)).toBeNull();
    }
  });
});

describe("PATCH a transaction", () => {
  it("date_only_edit_updates_date_and_month_and_nothing_else", async () => {
    const res = await PATCH(req({ date: "2026-05-15" }), { params });
    expect(res.status).toBe(200);
    expect(updateMany).toHaveBeenCalledOnce();
    expect(updateMany.mock.calls[0][0].data).toEqual({ date: "2026-05-15", month: "2026-05" });
  });

  it("date_only_edit_does_not_clear_uncategorized", async () => {
    await PATCH(req({ date: "2026-05-15" }), { params });
    const data = updateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("uncategorized");
    expect(data).not.toHaveProperty("category");
    expect(upsert).not.toHaveBeenCalled();
  });

  it("category_only_edit_still_works_unchanged", async () => {
    const res = await PATCH(req({ category: FOOD, rememberMerchant: true }), { params });
    expect(res.status).toBe(200);
    const data = updateMany.mock.calls[0][0].data;
    expect(data).toEqual({ category: FOOD, uncategorized: false, kind: "expense" });
    expect(data).not.toHaveProperty("date");
    expect(upsert).toHaveBeenCalledOnce();
  });

  it("date_and_category_together_apply_both", async () => {
    const res = await PATCH(req({ category: FOOD, date: "2026-05-15" }), { params });
    expect(res.status).toBe(200);
    expect(updateMany.mock.calls[0][0].data).toEqual({
      category: FOOD,
      uncategorized: false,
      kind: "expense",
      date: "2026-05-15",
      month: "2026-05",
    });
  });

  it("invalid_date_shapes_400", async () => {
    for (const bad of ["2026-2-3", "2026-02-31", "31/05/2026", "", 20260515]) {
      const res = await PATCH(req({ date: bad }), { params });
      expect(res.status, `for ${JSON.stringify(bad)}`).toBe(400);
    }
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("body_with_neither_field_400s", async () => {
    const res = await PATCH(req({ rememberMerchant: true }), { params });
    expect(res.status).toBe(400);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("rejects an unknown category before writing", async () => {
    const res = await PATCH(req({ category: "לא קיים" }), { params });
    expect(res.status).toBe(400);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("edits_rejected_while_agent_is_running", async () => {
    for (const status of ["dispatched", "processing"]) {
      for (const body of [{ date: "2026-05-15" }, { category: FOOD, rememberMerchant: true }]) {
        vi.clearAllMocks();
        leafSet.mockResolvedValue(new Set([FOOD]));
        // The conditional write matches nothing while the job is running.
        updateMany.mockResolvedValue({ count: 0 });
        findFirst.mockResolvedValue({ merchant: "יוחננוף", job: { status } });
        const res = await PATCH(req(body), { params });
        expect(res.status, `${status} / ${JSON.stringify(body)}`).toBe(409);
        expect(upsert).not.toHaveBeenCalled();
      }
    }
  });

  // The interleaving a check-then-write guard cannot cover: the pre-read sees a
  // settled job, the run route flips it to dispatched, and only the conditional
  // write catches it (plan Rev 3, Codex P1-f).
  it("edit_write_is_conditional_on_job_not_running", async () => {
    const where = { id: "txA", jobId: "jobA", job: { status: { notIn: ["dispatched", "processing"] } } };
    await PATCH(req({ date: "2026-05-15" }), { params });
    expect(updateMany.mock.calls[0][0].where).toEqual(where);

    // Same request, but the CAS loses: nothing written, no mapping upsert.
    vi.clearAllMocks();
    leafSet.mockResolvedValue(new Set([FOOD]));
    updateMany.mockResolvedValue({ count: 0 });
    findFirst.mockResolvedValue({ merchant: "יוחננוף", job: { status: "dispatched" } });
    const res = await PATCH(req({ category: FOOD, rememberMerchant: true }), { params });
    expect(res.status).toBe(409);
    expect(upsert).not.toHaveBeenCalled();
  });

  // Pins the guard's exact promise so nobody later reads it as stronger than it
  // is (Codex, PR #48). The predicate reads the parent at the statement's
  // snapshot and does not lock it: an edit accepted a moment before a re-run
  // starts is still discarded by that re-run — by design, since a re-run
  // rebuilds every row. What the guard DOES promise is the case below.
  it("guard_covers_already_running_only_not_a_later_rerun", async () => {
    // Promised: a job already running refuses the write outright.
    updateMany.mockResolvedValue({ count: 0 });
    findFirst.mockResolvedValue({ merchant: "יוחננוף", job: { status: "processing" } });
    expect((await PATCH(req({ date: "2026-05-15" }), { params })).status).toBe(409);

    // Not promised: a settled job accepts the write. Whether a re-run later
    // discards it is the documented re-run semantic, not this route's contract.
    vi.clearAllMocks();
    leafSet.mockResolvedValue(new Set([FOOD]));
    updateMany.mockResolvedValue({ count: 1 });
    findFirst.mockResolvedValue({ merchant: "יוחננוף", job: { status: "completed" } });
    expect((await PATCH(req({ date: "2026-05-15" }), { params })).status).toBe(200);
  });

  it("404s when the transaction does not exist", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    findFirst.mockResolvedValue(null);
    const res = await PATCH(req({ date: "2026-05-15" }), { params });
    expect(res.status).toBe(404);
  });

  it("refuses an unauthorized caller before touching anything", async () => {
    const { NextResponse } = await import("next/server");
    auth.mockResolvedValue(NextResponse.json({ error: "אין הרשאה" }, { status: 403 }));
    const res = await PATCH(req({ date: "2026-05-15" }), { params });
    expect(res.status).toBe(403);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

// ── Income invariant on writes (docs/plans/bank-statements.md B5) ─────────────
describe("PATCH — income leaves and bank credits", () => {
  const bankCredit = (over: Record<string, unknown> = {}) => ({
    merchant: "מעסיק",
    amountAgorot: -1900000,
    sourceLabel: "hapoalim-1812",
    job: { status: "completed", verification: BANK_VERIFICATION },
    ...over,
  });

  it("הכנסות leaf on a positive row ⇒ 400, nothing written", async () => {
    findFirst.mockResolvedValue(bankCredit({ amountAgorot: 1900000 }));
    const res = await PATCH(req({ category: SALARY }), { params });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/זיכוי/);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("הכנסות leaf on a card-source row ⇒ 400", async () => {
    findFirst.mockResolvedValue(bankCredit({ sourceLabel: "isracard-4962" }));
    const res = await PATCH(req({ category: SALARY }), { params });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/חשבון בנק/);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("הכנסות leaf on a card source that merely lacks a total ⇒ 400 (bank is the explicit flag)", async () => {
    findFirst.mockResolvedValue(bankCredit({ sourceLabel: "max-1-pending" }));
    expect((await PATCH(req({ category: SALARY }), { params })).status).toBe(400);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("הכנסות leaf without a stored verification fails closed (not a bank)", async () => {
    findFirst.mockResolvedValue(bankCredit({ job: { status: "completed", verification: null } }));
    expect((await PATCH(req({ category: SALARY }), { params })).status).toBe(400);
  });

  it("הכנסות leaf on a bank credit ⇒ 200 with kind income, and never remembered", async () => {
    findFirst.mockResolvedValue(bankCredit());
    const res = await PATCH(req({ category: SALARY, rememberMerchant: true }), { params });
    expect(res.status).toBe(200);
    expect(updateMany.mock.calls[0][0].data).toEqual({ category: SALARY, uncategorized: false, kind: "income" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("expense leaf on a kind=credit row ⇒ 200 with kind expense (a refund), not remembered", async () => {
    findFirst.mockResolvedValue(bankCredit({ kind: "credit" }));
    const res = await PATCH(req({ category: FOOD, rememberMerchant: true }), { params });
    expect(res.status).toBe(200);
    expect(updateMany.mock.calls[0][0].data).toEqual({ category: FOOD, uncategorized: false, kind: "expense" });
    // the row is negative: its merchant's dictionary entry would describe the debit direction
    expect(upsert).not.toHaveBeenCalled();
  });

  it("the write stays ONE conditional updateMany for a category edit", async () => {
    findFirst.mockResolvedValue(bankCredit());
    await PATCH(req({ category: SALARY }), { params });
    expect(updateMany).toHaveBeenCalledOnce();
    expect(updateMany.mock.calls[0][0].where).toEqual({
      id: "txA",
      jobId: "jobA",
      job: { status: { notIn: ["dispatched", "processing"] } },
    });
  });
});
