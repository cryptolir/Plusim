/**
 * Codex round 1, F23 — expired-token reconciliation. A `processing` row whose
 * token expired can NEVER complete (authorizeAgentJobRequest rejects expired
 * tokens before the result route writes), so failing it is race-free. The
 * predicate must key on token expiry, not wall-clock age — a live run's row
 * always carries an unexpired token.
 */
import { it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  db: { reportJob: { updateMany: vi.fn() } },
}));

import { db } from "@/lib/db";
import { reconcileExpiredProcessing } from "./reconcile";

const updateMany = db.reportJob.updateMany as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

it("fails only processing rows whose token expiry is strictly in the past", async () => {
  updateMany.mockResolvedValue({ count: 2 });
  const now = new Date("2026-07-30T12:00:00.000Z");
  const n = await reconcileExpiredProcessing(now);
  expect(n).toBe(2);
  expect(updateMany).toHaveBeenCalledExactlyOnceWith({
    where: { status: "processing", agentTokenExpiresAt: { lt: now } },
    data: { status: "failed", error: "run never completed before its token expired" },
  });
});

it("no expired rows → no writes beyond the single conditional updateMany", async () => {
  updateMany.mockResolvedValue({ count: 0 });
  await expect(reconcileExpiredProcessing()).resolves.toBe(0);
  expect(updateMany).toHaveBeenCalledTimes(1);
});
