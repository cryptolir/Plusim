/**
 * Enqueue-only run route (docs/plans/reports-scaling-stage1-2.md §3).
 * Named plan tests: 1 (202 + enqueue, no agent call), 8 (concurrent double
 * POST), 10 (send-failure revert restores the pre-CAS snapshot), 11 (stale
 * dispatched reclaim), 13 (route half — the CAS clears the token hash), 17
 * (generation-bound revert), 18 (rerun from failed clears error).
 */
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
const PREV_DISPATCHED_AT = new Date("2026-07-01T00:00:00.000Z");

function runReq() {
  return new NextRequest("https://plusim.xyz/admin/api/reports/jobA/run", { method: "POST" });
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: "jobA",
    status: "completed",
    dispatchedAt: PREV_DISPATCHED_AT,
    error: null,
    _count: { files: 2 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ actor: "admin@plusim.xyz" });
  jobFind.mockResolvedValue(snapshot());
  jobUpdateMany.mockResolvedValue({ count: 1 });
  send.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---- plan test 1 -----------------------------------------------------------
it("run route returns 202 and enqueues without calling the agent", async () => {
  const res = await runPOST(runReq(), params);
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ ok: true, status: "dispatched" });

  expect(send).toHaveBeenCalledTimes(1);
  const payload = send.mock.calls[0][0];
  expect(payload.jobId).toBe("jobA");
  // The generation key is the exact dispatchedAt the CAS wrote.
  const cas = jobUpdateMany.mock.calls[0][0];
  expect(payload.gen).toBe(cas.data.dispatchedAt.toISOString());
});

it("the route module no longer imports callAgent (plan test 1, static half)", () => {
  const src = readFileSync(
    fileURLToPath(new URL("./[jobId]/run/route.ts", import.meta.url)),
    "utf8",
  );
  expect(src).not.toContain('from "@/lib/agentglob"'); // no callAgent import
  expect(src).not.toContain("callAgent(");
  expect(src).not.toContain("maxDuration");
});

// ---- plan tests 13 (route half) + 18 ---------------------------------------
it("rerun from failed clears error and the previous run's token at CAS time", async () => {
  jobFind.mockResolvedValue(snapshot({ status: "failed", error: "dispatch failed: boom" }));
  const res = await runPOST(runReq(), params);
  expect(res.status).toBe(202);

  const cas = jobUpdateMany.mock.calls[0][0];
  // F12 — no stale failure shown through dispatched/processing.
  expect(cas.data.error).toBeNull();
  // F8 — a delayed callback carrying the previous run's token no-matches the
  // result route's acceptingWhere while the new run is queued.
  expect(cas.data.agentTokenHash).toBeNull();
  expect(cas.data.agentTokenExpiresAt).toBeNull();
  expect(cas.data.queueJobId).toBeNull();
});

// ---- plan test 8 ------------------------------------------------------------
it("concurrent double POST: exactly one 202, one 409, one queue entry, no revert", async () => {
  // Overlapping-read ordering: BOTH requests complete their pre-guard read
  // before EITHER runs its CAS — the ordering Codex named as the F7 attack.
  const readWaiters: Array<(v: unknown) => void> = [];
  jobFind.mockImplementation(
    () => new Promise((resolve) => readWaiters.push(() => resolve(snapshot()))),
  );
  jobUpdateMany
    .mockResolvedValueOnce({ count: 1 }) // first CAS wins
    .mockResolvedValueOnce({ count: 0 }); // second loses

  const p1 = runPOST(runReq(), params);
  const p2 = runPOST(runReq(), params);
  await vi.waitFor(() => expect(readWaiters.length).toBe(2));
  for (const release of readWaiters) release(undefined);

  const statuses = (await Promise.all([p1, p2])).map((r) => r.status).sort();
  expect(statuses).toEqual([202, 409]);
  expect(send).toHaveBeenCalledTimes(1);
  // Two CAS attempts, zero reverts.
  expect(jobUpdateMany).toHaveBeenCalledTimes(2);
});

// ---- plan test 10 -----------------------------------------------------------
it("send failure reverts only a pristine dispatched row and restores the pre-CAS snapshot", async () => {
  jobFind.mockResolvedValue(snapshot({ status: "completed", error: "old note" }));
  send.mockRejectedValue(new Error("pg-boss down"));
  const res = await runPOST(runReq(), params);
  expect(res.status).toBe(502);

  expect(jobUpdateMany).toHaveBeenCalledTimes(2);
  const cas = jobUpdateMany.mock.calls[0][0];
  const revert = jobUpdateMany.mock.calls[1][0];
  // Revert can never clobber a claimed run: pristine predicate + own generation.
  expect(revert.where).toMatchObject({
    id: "jobA",
    status: "dispatched",
    queueJobId: null,
    agentTokenHash: null,
  });
  expect(revert.where.dispatchedAt).toEqual(cas.data.dispatchedAt);
  // F20 — the FULL pre-CAS snapshot: the publish freshness guard
  // (completedAt < dispatchedAt) must never see the aborted generation's
  // watermark, so a completed job still publishes after a failed rerun enqueue.
  expect(revert.data).toEqual({
    status: "completed",
    dispatchedAt: PREV_DISPATCHED_AT,
    error: "old note",
  });
  // Token fields stay null after revert (fail closed) — not restored, not minted.
  expect(revert.data).not.toHaveProperty("agentTokenHash");
});

// ---- plan test 11 -----------------------------------------------------------
it("stale dispatched (queueJobId null, older than 2 min) is reclaimable; a fresh one 409s", async () => {
  vi.useFakeTimers({ now: new Date("2026-07-30T12:00:00.000Z") });
  jobFind.mockResolvedValue(snapshot({ status: "dispatched" }));

  // The CAS carries the reclaim arm with the 2-minute staleness bound…
  jobUpdateMany.mockResolvedValueOnce({ count: 1 });
  const ok = await runPOST(runReq(), params);
  expect(ok.status).toBe(202);
  const arm = jobUpdateMany.mock.calls[0][0].where.OR[1];
  expect(arm).toMatchObject({ status: "dispatched", queueJobId: null });
  expect(arm.dispatchedAt.lt).toEqual(new Date("2026-07-30T11:58:00.000Z"));

  // …so a fresh dispatch (CAS no-match) 409s without touching the queue.
  send.mockClear();
  jobUpdateMany.mockResolvedValueOnce({ count: 0 });
  const fresh = await runPOST(runReq(), params);
  expect(fresh.status).toBe(409);
  expect(send).not.toHaveBeenCalled();
});

// ---- plan test 17 -----------------------------------------------------------
it("send stalled past 2 min, second POST stale-reclaims, first send's revert no-matches the second generation", async () => {
  vi.useFakeTimers({ now: new Date("2026-07-30T12:00:00.000Z") });

  // Request A dispatches, then its send stalls.
  let rejectSendA: (e: Error) => void = () => {};
  send.mockImplementationOnce(() => new Promise((_, reject) => (rejectSendA = reject)));
  jobUpdateMany.mockResolvedValueOnce({ count: 1 });
  const pA = runPOST(runReq(), params);
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  const genA = jobUpdateMany.mock.calls[0][0].data.dispatchedAt;

  // Three minutes later request B stale-reclaims (new generation).
  vi.advanceTimersByTime(3 * 60_000);
  jobFind.mockResolvedValue(snapshot({ status: "dispatched", dispatchedAt: genA }));
  jobUpdateMany.mockResolvedValueOnce({ count: 1 });
  send.mockResolvedValueOnce(undefined);
  const resB = await runPOST(runReq(), params);
  expect(resB.status).toBe(202);
  const genB = jobUpdateMany.mock.calls[1][0].data.dispatchedAt;
  expect(genB).not.toEqual(genA);

  // A's send finally throws; its revert is bound to genA, which B's reclaim
  // CAS overwrote — so it matches nothing (F11).
  jobUpdateMany.mockResolvedValueOnce({ count: 0 });
  rejectSendA(new Error("stalled send failed"));
  const resA = await pA;
  expect(resA.status).toBe(502);
  const revert = jobUpdateMany.mock.calls[2][0];
  expect(revert.where.dispatchedAt).toEqual(genA);
  expect(revert.where.dispatchedAt).not.toEqual(genB);
});
