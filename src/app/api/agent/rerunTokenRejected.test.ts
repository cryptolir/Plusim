/**
 * Plan test 13 (F8): a delayed callback carrying the PREVIOUS run's token is
 * rejected after a rerun is enqueued. The run route's CAS clears
 * agentTokenHash (asserted in runEnqueue.test.ts), so between enqueue and the
 * worker's claim the stored hash is null — authorizeAgentJobRequest can match
 * nothing and returns 404 before the result route writes a byte. After the
 * claim mints a NEW hash, the old token's sha256 no-matches the same check.
 */
import { it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  db: {
    reportJob: { findUnique: vi.fn(), updateMany: vi.fn() },
    reportCategory: { findMany: vi.fn(async () => []) },
  },
}));

import { db } from "@/lib/db";
import { sha256Hex } from "@/lib/agentRuntimeAuth";
import { POST as resultPOST } from "./jobs/[jobId]/result/route";

const jobFind = db.reportJob.findUnique as unknown as ReturnType<typeof vi.fn>;
const jobUpdateMany = db.reportJob.updateMany as unknown as ReturnType<typeof vi.fn>;

const RUNTIME = "runtime-secret";
const OLD_TOKEN = "token-from-previous-run";
const params = { params: Promise.resolve({ jobId: "jobA" }) };

function req() {
  return new NextRequest(`https://plusim.xyz/api/agent/jobs/jobA/result?t=${OLD_TOKEN}`, {
    method: "POST",
    headers: { authorization: `Bearer ${RUNTIME}`, "content-type": "application/json" },
    body: JSON.stringify({ status: "ok", transactions: [], sourceTotals: [], xlsxBase64: "" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PLUSIM_AGENT_RUNTIME_TOKEN = RUNTIME;
});

it("rerun enqueued (hash cleared by the CAS) → old token 404s, nothing written", async () => {
  jobFind.mockResolvedValue({
    id: "jobA", targetUserId: "u1", status: "dispatched",
    agentTokenHash: null, agentTokenExpiresAt: null,
  });
  const res = await resultPOST(req(), params);
  expect(res.status).toBe(404);
  expect(jobUpdateMany).not.toHaveBeenCalled();
});

it("worker claimed and minted a NEW token → the old token still 404s", async () => {
  jobFind.mockResolvedValue({
    id: "jobA", targetUserId: "u1", status: "processing",
    agentTokenHash: sha256Hex("a-different-fresh-token"),
    agentTokenExpiresAt: new Date(Date.now() + 60_000),
  });
  const res = await resultPOST(req(), params);
  expect(res.status).toBe(404);
  expect(jobUpdateMany).not.toHaveBeenCalled();
});
