/**
 * result callback conditional write (publish/result race, Rev 2 — Codex P1):
 * the job update is conditional on status in (dispatched|processing) + the
 * authorizing token hash. If a publish/re-dispatch slipped in between auth and
 * the write, updateMany affects 0 rows ⇒ 409 and NOTHING is persisted.
 */
import { it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => {
  const tx = {
    reportJob: { updateMany: vi.fn() },
    reportTransaction: { deleteMany: vi.fn(), createMany: vi.fn() },
    reportArtifact: { deleteMany: vi.fn(), create: vi.fn() },
  };
  return {
    __tx: tx,
    db: {
      reportJob: { findUnique: vi.fn(), updateMany: vi.fn() },
      merchantMapping: { upsert: vi.fn() },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    },
  };
});

import * as dbmod from "@/lib/db";
import { sha256Hex } from "@/lib/agentRuntimeAuth";
import { POST as resultPOST } from "./jobs/[jobId]/result/route";

const db = (dbmod as unknown as { db: Record<string, { [k: string]: ReturnType<typeof vi.fn> }> }).db;
const tx = (dbmod as unknown as { __tx: { reportJob: { updateMany: ReturnType<typeof vi.fn> }; reportTransaction: { createMany: ReturnType<typeof vi.fn> } } }).__tx;
const RUNTIME = "runtime-secret";
const TOKEN = "job-token";

const zipB64 = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]).toString("base64");
const payload = {
  status: "ok",
  transactions: [
    { month: "2026-06", date: "2026-06-14", merchant: "יוחננוף", amountAgorot: 1579, category: "מזון ומכולת", uncategorized: false, sourceLabel: "isracard-4962", dedupKey: "v-1" },
  ],
  sourceTotals: [{ label: "isracard-4962", statementTotalAgorot: 1579, computedTotalAgorot: 1579 }],
  xlsxBase64: zipB64,
};

function req() {
  return new NextRequest(`https://plusim.xyz/api/agent/jobs/jobA/result?t=${TOKEN}`, {
    method: "POST",
    headers: { authorization: `Bearer ${RUNTIME}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}
const params = { params: Promise.resolve({ jobId: "jobA" }) };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PLUSIM_AGENT_RUNTIME_TOKEN = RUNTIME;
  db.reportJob.findUnique.mockResolvedValue({
    id: "jobA", targetUserId: "u1", status: "processing",
    agentTokenHash: sha256Hex(TOKEN), agentTokenExpiresAt: new Date(Date.now() + 60_000),
  });
});

it("job published between auth and write (0 rows) → 409, nothing written", async () => {
  tx.reportJob.updateMany.mockResolvedValue({ count: 0 });
  const res = await resultPOST(req(), params);
  expect(res.status).toBe(409);
  expect(tx.reportTransaction.createMany).not.toHaveBeenCalled();
});

it("still-open job (1 row) → 200, transactions written", async () => {
  tx.reportJob.updateMany.mockResolvedValue({ count: 1 });
  const res = await resultPOST(req(), params);
  expect(res.status).toBe(200);
  expect(tx.reportTransaction.createMany).toHaveBeenCalled();
});
