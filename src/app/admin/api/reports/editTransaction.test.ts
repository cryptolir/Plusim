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
vi.mock("@/lib/reportCategories", () => ({ getValidLeafSet: vi.fn() }));

import { db } from "@/lib/db";
import { authorizeReportsRequest } from "@/lib/reportsAdminAuth";
import { getValidLeafSet } from "@/lib/reportCategories";
import { PATCH, normalizeDate } from "./[jobId]/transactions/[txId]/route";

const auth = authorizeReportsRequest as unknown as ReturnType<typeof vi.fn>;
const updateMany = db.reportTransaction.updateMany as unknown as ReturnType<typeof vi.fn>;
const findFirst = db.reportTransaction.findFirst as unknown as ReturnType<typeof vi.fn>;
const upsert = db.merchantMapping.upsert as unknown as ReturnType<typeof vi.fn>;
const leafSet = getValidLeafSet as unknown as ReturnType<typeof vi.fn>;

const FOOD = "מזון ומכולת";
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
  leafSet.mockResolvedValue(new Set([FOOD]));
  updateMany.mockResolvedValue({ count: 1 });
  findFirst.mockResolvedValue({ merchant: "יוחננוף", job: { status: "completed" } });
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
    expect(data).toEqual({ category: FOOD, uncategorized: false });
    expect(data).not.toHaveProperty("date");
    expect(upsert).toHaveBeenCalledOnce();
  });

  it("date_and_category_together_apply_both", async () => {
    const res = await PATCH(req({ category: FOOD, date: "2026-05-15" }), { params });
    expect(res.status).toBe(200);
    expect(updateMany.mock.calls[0][0].data).toEqual({
      category: FOOD,
      uncategorized: false,
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
