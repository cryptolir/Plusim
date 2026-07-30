/**
 * Re-running a PUBLISHED job (the update path) requires a deliberate opt-in.
 * Named cases banked by the plan review of PR #23, updated for the enqueue-only
 * route (docs/plans/reports-scaling-stage1-2.md §3; plan test 2):
 *   run_published_without_confirm_409, run_published_with_confirm_dispatches.
 */
import { it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/reportsAdminAuth", () => ({ authorizeReportsRequest: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: { reportJob: { findUnique: vi.fn(), updateMany: vi.fn() } },
}));
vi.mock("@/lib/reportQueue", () => ({ sendReportDispatch: vi.fn() }));

import { db } from "@/lib/db";
import { authorizeReportsRequest } from "@/lib/reportsAdminAuth";
import { sendReportDispatch } from "@/lib/reportQueue";
import { POST as runPOST } from "./[jobId]/run/route";

const auth = authorizeReportsRequest as unknown as ReturnType<typeof vi.fn>;
const jobFind = db.reportJob.findUnique as unknown as ReturnType<typeof vi.fn>;
const jobUpdateMany = db.reportJob.updateMany as unknown as ReturnType<typeof vi.fn>;
const send = sendReportDispatch as unknown as ReturnType<typeof vi.fn>;

const params = { params: Promise.resolve({ jobId: "jobA" }) };

function runReq(body?: unknown) {
  return new NextRequest("https://plusim.xyz/admin/api/reports/jobA/run", {
    method: "POST",
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ actor: "admin@plusim.xyz" });
  jobFind.mockResolvedValue({
    id: "jobA",
    status: "published",
    dispatchedAt: new Date("2026-07-01T00:00:00.000Z"),
    error: null,
    _count: { files: 3 },
  });
  jobUpdateMany.mockResolvedValue({ count: 1 });
  send.mockResolvedValue(undefined);
});

it("run_published_without_confirm_409 — no body", async () => {
  const res = await runPOST(runReq(), params);
  expect(res.status).toBe(409);
  expect(jobUpdateMany).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});

it("run_published_without_confirm_409 — explicit false", async () => {
  const res = await runPOST(runReq({ confirmUpdate: false }), params);
  expect(res.status).toBe(409);
  expect(jobUpdateMany).not.toHaveBeenCalled();
});

it("run_published_with_confirm_dispatches — published joins the CAS set; publishedAt/sheetUrl untouched", async () => {
  const res = await runPOST(runReq({ confirmUpdate: true }), params);
  expect(res.status).toBe(202);

  const cas = jobUpdateMany.mock.calls[0][0];
  // confirmUpdate is consumed at ENQUEUE time by widening the CAS status set —
  // the worker's claim re-check (status="dispatched" only) covers the window
  // after it (invariant I2).
  // F27: the CAS pins the snapshot status, so "published joins the set" now
  // means the pre-read guard admitted it and the CAS matches exactly it.
  expect(cas.where.status).toBe("published");
  expect(cas.data).toMatchObject({ status: "dispatched", agentTokenHash: null });
  // History and the export target survive an update run.
  expect(cas.data).not.toHaveProperty("publishedAt");
  expect(cas.data).not.toHaveProperty("sheetUrl");
  expect(send).toHaveBeenCalled();
});

it("a non-published job still runs with no body (unchanged behaviour)", async () => {
  jobFind.mockResolvedValue({
    id: "jobA",
    status: "completed",
    dispatchedAt: new Date("2026-07-01T00:00:00.000Z"),
    error: null,
    _count: { files: 1 },
  });
  const res = await runPOST(runReq(), params);
  expect(res.status).toBe(202);
  const cas = jobUpdateMany.mock.calls[0][0];
  expect(cas.where.status).toBe("completed");
});
