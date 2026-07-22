/**
 * The trust-boundary glue (plan Rev 3, Codex round-2): the result callback
 * verifies against the MERGED (base ∪ ReportCategory) leaf set — an agent
 * result using an admin-added category must complete non-fatal, and a DB-leaf
 * proposed mapping must survive parseAgentResult, through the REAL route.
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
      reportCategory: { findMany: vi.fn() },
      merchantMapping: { upsert: vi.fn() },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    },
  };
});

import * as dbmod from "@/lib/db";
import { sha256Hex } from "@/lib/agentRuntimeAuth";
import { POST as resultPOST } from "./jobs/[jobId]/result/route";

type Mock = ReturnType<typeof vi.fn>;
const db = (dbmod as unknown as { db: Record<string, Record<string, Mock>> }).db;
const tx = (dbmod as unknown as { __tx: Record<string, Record<string, Mock>> }).__tx;

const RUNTIME = "runtime-secret";
const TOKEN = "job-token";
const DB_LEAF = "קטגוריה חדשה";
const zipB64 = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]).toString("base64");

const payload = {
  status: "ok",
  transactions: [
    { month: "2026-06", date: "2026-06-14", merchant: "חנות חדשה", amountAgorot: 1579, category: DB_LEAF, uncategorized: false, sourceLabel: "isracard-4962", dedupKey: "v-1" },
  ],
  sourceTotals: [{ label: "isracard-4962", statementTotalAgorot: 1579, computedTotalAgorot: 1579 }],
  xlsxBase64: zipB64,
  proposedMappings: [{ merchant: "חנות חדשה", category: DB_LEAF }],
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
  tx.reportJob.updateMany.mockResolvedValue({ count: 1 });
});

it("DB-leaf result verifies non-fatal and its mapping survives (test_result_callback_verifies_against_merged_set)", async () => {
  db.reportCategory.findMany.mockResolvedValue([{ name: DB_LEAF, section: "שונות" }]);
  const res = await resultPOST(req(), params);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.fatal).toBe(false);
  expect(body.status).toBe("completed");
  // the STORED verification is non-fatal (what the publish guard later reads)
  const stored = tx.reportJob.updateMany.mock.calls[0][0].data;
  expect(stored.status).toBe("completed");
  expect(stored.verification.fatal).toBe(false);
  expect(stored.verification.problems).toHaveLength(0);
  // the DB-leaf proposed mapping was NOT dropped by parseAgentResult
  expect(db.merchantMapping.upsert).toHaveBeenCalledWith(
    expect.objectContaining({ where: { merchantPattern: "חנות חדשה" } }),
  );
});

it("without the ReportCategory row the same result is fatal → needs_review (fail closed)", async () => {
  db.reportCategory.findMany.mockResolvedValue([]);
  const res = await resultPOST(req(), params);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.fatal).toBe(true);
  expect(body.status).toBe("needs_review");
  expect(db.merchantMapping.upsert).not.toHaveBeenCalled();
});
