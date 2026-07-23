/**
 * Re-running a PUBLISHED job (the update path) requires a deliberate opt-in.
 * Named cases banked by the plan review of PR #23:
 *   run_published_without_confirm_409, run_published_with_confirm_dispatches.
 */
import { it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/reportsAdminAuth", () => ({ authorizeReportsRequest: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: { reportJob: { findUnique: vi.fn(), update: vi.fn() } },
}));
vi.mock("@/lib/agentRuntimeAuth", () => ({
  mintJobToken: vi.fn(() => ({ token: "raw-token", tokenHash: "hash-new", expiresAt: new Date("2026-08-01") })),
  appBaseUrl: () => "https://plusim.xyz",
}));
vi.mock("@/lib/agentglob", () => ({ callAgent: vi.fn() }));

import { db } from "@/lib/db";
import { authorizeReportsRequest } from "@/lib/reportsAdminAuth";
import { callAgent } from "@/lib/agentglob";
import { POST as runPOST } from "./[jobId]/run/route";

const auth = authorizeReportsRequest as unknown as ReturnType<typeof vi.fn>;
const jobFind = db.reportJob.findUnique as unknown as ReturnType<typeof vi.fn>;
const jobUpdate = db.reportJob.update as unknown as ReturnType<typeof vi.fn>;
const agent = callAgent as unknown as ReturnType<typeof vi.fn>;

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
  jobFind.mockResolvedValue({ id: "jobA", status: "published", _count: { files: 3 } });
  jobUpdate.mockResolvedValue({});
  agent.mockResolvedValue({ reply: "ok" });
});

it("run_published_without_confirm_409 — no body", async () => {
  const res = await runPOST(runReq(), params);
  expect(res.status).toBe(409);
  expect(jobUpdate).not.toHaveBeenCalled();
  expect(agent).not.toHaveBeenCalled();
});

it("run_published_without_confirm_409 — explicit false", async () => {
  const res = await runPOST(runReq({ confirmUpdate: false }), params);
  expect(res.status).toBe(409);
  expect(jobUpdate).not.toHaveBeenCalled();
});

it("run_published_with_confirm_dispatches — fresh token, publishedAt/sheetUrl untouched", async () => {
  jobFind
    .mockResolvedValueOnce({ id: "jobA", status: "published", _count: { files: 3 } })
    .mockResolvedValueOnce({ status: "processing" });

  const res = await runPOST(runReq({ confirmUpdate: true }), params);
  expect(res.status).toBe(200);

  const dispatch = jobUpdate.mock.calls[0][0];
  expect(dispatch.data).toMatchObject({ status: "dispatched", agentTokenHash: "hash-new" });
  // History and the export target survive an update run.
  expect(dispatch.data).not.toHaveProperty("publishedAt");
  expect(dispatch.data).not.toHaveProperty("sheetUrl");
  expect(agent).toHaveBeenCalled();
});

it("a non-published job still runs with no body (unchanged behaviour)", async () => {
  jobFind
    .mockResolvedValueOnce({ id: "jobA", status: "completed", _count: { files: 1 } })
    .mockResolvedValueOnce({ status: "processing" });
  const res = await runPOST(runReq(), params);
  expect(res.status).toBe(200);
  expect(jobUpdate).toHaveBeenCalled();
});
