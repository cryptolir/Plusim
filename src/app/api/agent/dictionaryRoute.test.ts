/**
 * POST /api/agent/jobs/:jobId/dictionary — the server-side merchant dictionary
 * (docs/plans/scale-large-statements.md B3). Only approved mappings, only for
 * the merchants asked about, only valid non-income leaves; > 500 merchants ⇒ 400.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  db: {
    reportJob: { findUnique: vi.fn() },
    reportCategory: { findMany: vi.fn(async () => []) },
    merchantMapping: { findMany: vi.fn() },
  },
}));

import { db } from "@/lib/db";
import { sha256Hex } from "@/lib/agentRuntimeAuth";
import { REPORT_TAXONOMY, INCOME_SECTION } from "@/config/reportTaxonomy";
import { POST } from "./jobs/[jobId]/dictionary/route";

const RUNTIME = "runtime-secret";
const TOKEN = "job-token";
const jobFind = db.reportJob.findUnique as unknown as ReturnType<typeof vi.fn>;
const mappingFind = db.merchantMapping.findMany as unknown as ReturnType<typeof vi.fn>;

const expenseLeaf = REPORT_TAXONOMY.find((s) => s.section !== INCOME_SECTION)!.leaves[0];
const incomeLeaf = REPORT_TAXONOMY.find((s) => s.section === INCOME_SECTION)!.leaves[0];

function post(body: unknown) {
  return new NextRequest(`https://plusim.xyz/api/agent/jobs/jobA/dictionary?t=${TOKEN}`, {
    method: "POST",
    headers: { authorization: `Bearer ${RUNTIME}`, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const params = { params: Promise.resolve({ jobId: "jobA" }) };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PLUSIM_AGENT_RUNTIME_TOKEN = RUNTIME;
  jobFind.mockResolvedValue({
    id: "jobA",
    targetUserId: "user-1",
    status: "processing",
    agentTokenHash: sha256Hex(TOKEN),
    agentTokenExpiresAt: new Date(Date.now() + 60_000),
  });
  mappingFind.mockResolvedValue([]);
});

describe("dictionary route", () => {
  it("queries only approved mappings for exactly the requested merchants", async () => {
    const res = await POST(post({ merchants: ["חנות א", "חנות ב", "חנות א"] }), params);
    expect(res.status).toBe(200);
    expect(mappingFind).toHaveBeenCalledTimes(1);
    const where = mappingFind.mock.calls[0][0].where;
    expect(where.approved).toBe(true);
    expect(where.merchantPattern.in).toEqual(["חנות א", "חנות ב"]);
  });

  it("returns only valid, non-income leaves", async () => {
    mappingFind.mockResolvedValue([
      { merchantPattern: "חנות א", category: expenseLeaf },
      { merchantPattern: "מעסיק", category: incomeLeaf },
      { merchantPattern: "ישן", category: "קטגוריה שנמחקה" },
    ]);
    const res = await POST(post({ merchants: ["חנות א", "מעסיק", "ישן"] }), params);
    expect(await res.json()).toEqual({ hits: { "חנות א": expenseLeaf } });
  });

  it("more than 500 merchants → 400, no query", async () => {
    const merchants = Array.from({ length: 501 }, (_, i) => `m${i}`);
    const res = await POST(post({ merchants }), params);
    expect(res.status).toBe(400);
    expect(mappingFind).not.toHaveBeenCalled();
  });

  it("exactly 500 merchants is accepted", async () => {
    const merchants = Array.from({ length: 500 }, (_, i) => `m${i}`);
    expect((await POST(post({ merchants }), params)).status).toBe(200);
  });

  it.each([
    ["empty list", { merchants: [] }],
    ["not a list", { merchants: "חנות" }],
    ["a non-string", { merchants: ["חנות", 7] }],
    ["an empty string", { merchants: [""] }],
    ["a string over 200 chars", { merchants: ["x".repeat(201)] }],
    ["no body field", {}],
  ])("%s → 400, no query", async (_label, body) => {
    const res = await POST(post(body), params);
    expect(res.status).toBe(400);
    expect(mappingFind).not.toHaveBeenCalled();
  });

  it("invalid JSON → 400", async () => {
    expect((await POST(post("{not json"), params)).status).toBe(400);
  });

  it("an oversized body → 413, no query", async () => {
    const res = await POST(post({ merchants: ["x"], pad: "y".repeat(600 * 1024) }), params);
    expect(res.status).toBe(413);
    expect(mappingFind).not.toHaveBeenCalled();
  });
});
