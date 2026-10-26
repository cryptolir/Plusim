/**
 * The adjustment-chat trust boundary end to end against an in-memory db
 * (docs/plans/report-adjust-chat.md B3, B5, B6, B7, B7a):
 *   - authorizeAdjustRequest (both token kinds, generation binding),
 *   - test_old_turn_after_rerun_completes_is_rejected (Codex P1, Rev 2),
 *   - the adjust route (strict body, all-or-nothing, income invariant),
 *   - test_adjust_cannot_supply_workbook_bytes (Codex P1, Rev 2),
 *   - test_rebuilt_workbook_matches_db_rows,
 *   - test_reversed_rebuild_completion_keeps_the_newer_workbook (Codex P1, Rev 3),
 *   - ensureFreshWorkbook (the publish/download recovery path, Rev 3).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  jobs: [] as Record<string, unknown>[],
  txns: [] as Record<string, unknown>[],
  artifacts: [] as Record<string, unknown>[],
  onTxnFindMany: null as null | (() => void),
}));

function matches(rec: Row, where: Row | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => {
    if (k === "OR") return (v as Row[]).some((w) => matches(rec, w));
    const actual = rec[k];
    if (v instanceof Date) return actual instanceof Date && actual.getTime() === v.getTime();
    if (v && typeof v === "object") {
      const o = v as { in?: unknown[]; lt?: unknown; notIn?: unknown[] };
      if (o.in) return o.in.some((x) => (x instanceof Date ? (actual as Date)?.getTime?.() === x.getTime() : x === actual));
      if (o.notIn) return !o.notIn.includes(actual);
      if ("lt" in o) {
        const lt = o.lt;
        if (lt instanceof Date) return actual instanceof Date && actual.getTime() < lt.getTime();
        return (actual as number) < (lt as number);
      }
    }
    return actual === v;
  });
}
function pick(rec: Row, select?: Row): Row {
  if (!select) return { ...rec };
  return Object.fromEntries(Object.keys(select).map((k) => [k, rec[k]]));
}
function applyData(rec: Row, data: Row) {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && "increment" in (v as Row)) rec[k] = (rec[k] as number) + ((v as { increment: number }).increment);
    else rec[k] = v;
  }
}

vi.mock("@/lib/db", () => {
  const db = {
    reportJob: {
      findUnique: vi.fn(async ({ where, select }: { where: Row; select?: Row }) => {
        const j = state.jobs.find((x) => x.id === where.id);
        return j ? pick(j, select) : null;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const hit = state.jobs.filter((j) => matches(j, where));
        hit.forEach((j) => applyData(j, data));
        return { count: hit.length };
      }),
    },
    reportTransaction: {
      findMany: vi.fn(async ({ where, select }: { where: Row; select?: Row }) => {
        const out = state.txns.filter((t) => matches(t, where)).map((t) => pick(t, select));
        const hook = state.onTxnFindMany;
        state.onTxnFindMany = null;
        hook?.();
        return out;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const hit = state.txns.filter((t) => matches(t, where));
        hit.forEach((t) => applyData(t, data));
        return { count: hit.length };
      }),
    },
    reportArtifact: {
      findFirst: vi.fn(async ({ where, select }: { where: Row; select?: Row }) => {
        const a = state.artifacts.filter((x) => matches(x, where)).at(-1);
        return a ? pick(a, select) : null;
      }),
      deleteMany: vi.fn(async ({ where }: { where: Row }) => {
        const before = state.artifacts.length;
        state.artifacts = state.artifacts.filter((a) => !matches(a, where));
        return { count: before - state.artifacts.length };
      }),
      create: vi.fn(async ({ data }: { data: Row }) => {
        state.artifacts.push({ ...data });
        return data;
      }),
    },
    reportCategory: { findMany: vi.fn(async () => []) },
    // Interactive transaction with rollback: restore every table on throw.
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const snap = structuredClone({ jobs: state.jobs, txns: state.txns, artifacts: state.artifacts });
      try {
        return await fn(db);
      } catch (e) {
        state.jobs = snap.jobs;
        state.txns = snap.txns;
        state.artifacts = snap.artifacts;
        throw e;
      }
    }),
  };
  return { db };
});

vi.mock("@/lib/workbookBuilder", () => ({ runWorkbookBuilder: vi.fn() }));

import { db } from "@/lib/db";
import { runWorkbookBuilder } from "@/lib/workbookBuilder";
import { sha256Hex, authorizeAdjustRequest, authorizeAgentJobRequest } from "@/lib/agentRuntimeAuth";
import { REPORT_TAXONOMY, INCOME_SECTION } from "@/config/reportTaxonomy";
import { GET as rowsGET } from "./jobs/[jobId]/rows/route";
import { POST as adjustPOST } from "./jobs/[jobId]/adjust/route";
import { rebuildReportWorkbook, ensureFreshWorkbook, toWorkbookTxn } from "@/lib/reportWorkbook";

const builder = runWorkbookBuilder as unknown as ReturnType<typeof vi.fn>;
const RUNTIME = "runtime-secret";
const TOKEN = "adjust-token";
const RUN_TOKEN = "run-token";
const G1 = new Date("2026-10-01T10:00:00.000Z");
const G2 = new Date("2026-10-02T10:00:00.000Z");
const expenseLeaf = REPORT_TAXONOMY.find((s) => s.section !== INCOME_SECTION)!.leaves[0];
const expenseLeaf2 = REPORT_TAXONOMY.find((s) => s.section !== INCOME_SECTION)!.leaves[1];
const incomeLeaf = REPORT_TAXONOMY.find((s) => s.section === INCOME_SECTION)!.leaves[0];

function seed(jobOver: Row = {}) {
  state.jobs = [
    {
      id: "jobA",
      targetUserId: "u1",
      status: "published",
      dispatchedAt: G1,
      verification: { perSource: [{ label: "hapoalim-1812", bank: true }, { label: "max-1" }] },
      agentTokenHash: null,
      agentTokenExpiresAt: null,
      adjustTokenHash: sha256Hex(TOKEN),
      adjustTokenExpiresAt: new Date(Date.now() + 60_000),
      adjustGeneration: G1,
      rowsRevision: 0,
      artifactRevision: 0,
      ...jobOver,
    },
    {
      id: "jobB",
      targetUserId: "u2",
      status: "published",
      dispatchedAt: G1,
      verification: null,
      adjustTokenHash: null,
      adjustTokenExpiresAt: null,
      adjustGeneration: null,
      rowsRevision: 0,
      artifactRevision: 0,
    },
  ];
  const t = (id: string, over: Row = {}) => ({
    id,
    jobId: "jobA",
    month: "2026-05",
    date: "2026-05-15",
    merchant: `עסק ${id}`,
    amountAgorot: 1000,
    category: expenseLeaf,
    uncategorized: false,
    sourceLabel: "max-1",
    note: null,
    kind: "expense",
    dedupKey: `k-${id}`,
    ...over,
  });
  state.txns = [
    t("t1"),
    t("t2", { date: "2026-05-20" }),
    t("credit", { amountAgorot: -50000, sourceLabel: "hapoalim-1812", category: null, uncategorized: true, kind: "credit" }),
    t("other", { jobId: "jobB" }),
  ];
  state.artifacts = [{ jobId: "jobA", filename: "plusim-report-jobA.xlsx", bytes: Buffer.from("PK-original") }];
}

function req(pathname: string, opts: { t?: string; bearer?: string; body?: unknown } = {}) {
  const url = `https://plusim.xyz/api/agent/jobs/jobA/${pathname}${opts.t === undefined ? `?t=${TOKEN}` : opts.t ? `?t=${opts.t}` : ""}`;
  return new NextRequest(url, {
    method: opts.body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${opts.bearer ?? RUNTIME}`,
      ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(opts.body === undefined ? {} : { body: typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body) }),
  });
}
const params = { params: Promise.resolve({ jobId: "jobA" }) };
const adjust = (body: unknown, t?: string) => adjustPOST(req("adjust", { body, t }), params);
const job = () => state.jobs[0];
const txn = (id: string) => state.txns.find((t) => t.id === id)!;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PLUSIM_AGENT_RUNTIME_TOKEN = RUNTIME;
  seed();
  builder.mockImplementation(async () => Buffer.from(`PK-rebuilt`));
});

describe("authorizeAdjustRequest", () => {
  const auth = (t?: string, bearer?: string) => authorizeAdjustRequest(req("rows", { t, bearer }), "jobA");
  const status = async (p: ReturnType<typeof auth>) => {
    const r = await p;
    return r instanceof NextResponse ? r.status : 200;
  };

  it("no bearer ⇒ 401; no t ⇒ 404; another job's token ⇒ 404", async () => {
    expect(await status(auth(undefined, "wrong"))).toBe(401);
    expect(await status(auth(""))).toBe(404);
    expect(await status(authorizeAdjustRequest(req("rows"), "jobB"))).toBe(404);
  });
  it("expired ⇒ 404", async () => {
    job().adjustTokenExpiresAt = new Date(Date.now() - 1);
    expect(await status(auth())).toBe(404);
  });
  it.each(["dispatched", "processing", "uploaded", "failed"])("status %s ⇒ 404", async (s) => {
    job().status = s;
    expect(await status(auth())).toBe(404);
  });
  it.each(["published", "completed", "needs_review"])("status %s ⇒ allowed", async (s) => {
    job().status = s;
    expect(await status(auth())).toBe(200);
  });
  it("adjustGeneration ≠ dispatchedAt, or null ⇒ 404", async () => {
    job().adjustGeneration = G2;
    expect(await status(auth())).toBe(404);
    job().adjustGeneration = null;
    expect(await status(auth())).toBe(404);
  });
  it("a run token does not authorize adjust, and an adjust token does not authorize the run routes", async () => {
    job().agentTokenHash = sha256Hex(RUN_TOKEN);
    job().agentTokenExpiresAt = new Date(Date.now() + 60_000);
    expect(await status(auth(RUN_TOKEN))).toBe(404);
    const runAuth = await authorizeAgentJobRequest(req("manifest", { t: TOKEN }), "jobA");
    expect(runAuth instanceof NextResponse && runAuth.status).toBe(404);
  });
});

describe("test_old_turn_after_rerun_completes_is_rejected", () => {
  it("generation check alone: token columns left set, re-run to G2 completed ⇒ rows and adjust 404, nothing written", async () => {
    job().dispatchedAt = G2; // re-run dispatched and completed, B6 revocation deliberately NOT applied
    job().status = "completed";
    expect((await rowsGET(req("rows"), params)).status).toBe(404);
    const res = await adjust({ edits: [{ id: "t1", date: "2026-06-01" }] });
    expect(res.status).toBe(404);
    expect(txn("t1").date).toBe("2026-05-15");
    expect(job().rowsRevision).toBe(0);
  });
  it("with B6's revocation (the run route's dispatch write) ⇒ 404 too", async () => {
    Object.assign(job(), { dispatchedAt: G2, status: "completed", adjustTokenHash: null, adjustTokenExpiresAt: null, adjustGeneration: null });
    expect((await adjust({ edits: [{ id: "t1", date: "2026-06-01" }] })).status).toBe(404);
  });
});

describe("rows route", () => {
  it("returns this job's rows with ids and the merged taxonomy", async () => {
    const res = await rowsGET(req("rows"), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.transactions.map((t: Row) => t.id).sort()).toEqual(["credit", "t1", "t2"]);
    expect(body.taxonomy.length).toBeGreaterThan(0);
  });
});

describe("adjust route", () => {
  it("applies a date edit: month derived, note annotated, revision bumped, workbook rebuilt", async () => {
    const res = await adjust({ edits: [{ id: "t1", date: "2026-06-02" }] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      applied: [{ id: "t1", merchant: "עסק t1", field: "date", from: "2026-05-15", to: "2026-06-02" }],
      workbook: "updated",
    });
    expect(txn("t1")).toMatchObject({ date: "2026-06-02", month: "2026-06", amountAgorot: 1000 });
    expect(txn("t1").note).toBe('תוקן ע"י המנהל: תאריך 2026-05-15 → 2026-06-02');
    expect(job()).toMatchObject({ rowsRevision: 1, artifactRevision: 1 });
    expect(state.artifacts).toHaveLength(1);
    expect(String(state.artifacts[0].bytes)).toBe("PK-rebuilt");
  });

  it("the claim carries status, the exact token and the exact generation", async () => {
    await adjust({ edits: [{ id: "t1", date: "2026-06-02" }] });
    const claim = (db.reportJob.updateMany as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(claim.where).toMatchObject({ id: "jobA", adjustTokenHash: sha256Hex(TOKEN), dispatchedAt: G1 });
    expect(claim.where.status.in).toEqual(["completed", "needs_review", "published"]);
    // every row write is scoped to this job
    const writes = (db.reportTransaction.updateMany as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(writes.every(([a]) => a.where.jobId === "jobA")).toBe(true);
  });

  it.each([
    ["amountAgorot in an edit", { edits: [{ id: "t1", amountAgorot: 1 }] }],
    ["sourceLabel in an edit", { edits: [{ id: "t1", sourceLabel: "x" }] }],
    ["jobId in an edit", { edits: [{ id: "t1", jobId: "jobB" }] }],
    ["an extra top-level field", { edits: [{ id: "t1", date: "2026-06-01" }], note: "x" }],
    ["empty edits", { edits: [] }],
    ["101 edits", { edits: Array.from({ length: 101 }, (_, i) => ({ id: `x${i}`, date: "2026-06-01" })) }],
    ["duplicate ids", { edits: [{ id: "t1", date: "2026-06-01" }, { id: "t1", category: expenseLeaf2 }] }],
    ["an edit with nothing to change", { edits: [{ id: "t1" }] }],
    ["not an object", [1, 2]],
  ])("%s ⇒ 400, nothing written", async (_l, body) => {
    const res = await adjust(body);
    expect(res.status).toBe(400);
    expect(job().rowsRevision).toBe(0);
    expect(txn("t1").date).toBe("2026-05-15");
    expect(builder).not.toHaveBeenCalled();
  });

  it("test_adjust_cannot_supply_workbook_bytes — top level or inside an edit ⇒ 400, artifact untouched", async () => {
    for (const body of [
      { edits: [{ id: "t1", date: "2026-06-01" }], xlsxBase64: "UEsDBA==" },
      { edits: [{ id: "t1", date: "2026-06-01", xlsxBase64: "UEsDBA==" }] },
    ]) {
      expect((await adjust(body)).status).toBe(400);
    }
    expect(String(state.artifacts[0].bytes)).toBe("PK-original");
    expect(builder).not.toHaveBeenCalled();
  });

  it("test_adjust_cannot_supply_workbook_bytes — no agent route other than result writes reportArtifact", () => {
    const root = path.join(process.cwd(), "src/app/api/agent/jobs");
    const files = (function walk(d: string): string[] {
      return readdirSync(d).flatMap((n) => {
        const f = path.join(d, n);
        return statSync(f).isDirectory() ? walk(f) : f.endsWith("route.ts") ? [f] : [];
      });
    })(root);
    const writers = files.filter((f) => /reportArtifact\.(create|update|upsert|deleteMany|delete)/.test(readFileSync(f, "utf8")));
    expect(writers.map((f) => path.relative(root, f))).toEqual([path.join("[jobId]", "result", "route.ts")]);
  });

  it("a missing id (or another job's row) ⇒ 409, nothing written", async () => {
    for (const id of ["nope", "other"]) {
      const res = await adjust({ edits: [{ id: "t1", date: "2026-06-01" }, { id, date: "2026-06-01" }] });
      expect(res.status).toBe(409);
    }
    expect(txn("t1").date).toBe("2026-05-15");
    expect(txn("other").date).toBe("2026-05-15");
    expect(job().rowsRevision).toBe(0);
  });

  it("one invalid edit among valid ones rolls back ALL of them", async () => {
    const res = await adjust({
      edits: [
        { id: "t1", date: "2026-06-01" },
        { id: "t2", date: "2026-02-31" },
      ],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("עסק t2");
    expect(txn("t1").date).toBe("2026-05-15");
    expect(job().rowsRevision).toBe(0);
  });

  it("category outside the merged set ⇒ 400", async () => {
    expect((await adjust({ edits: [{ id: "t1", category: "לא קיים" }] })).status).toBe(400);
  });

  it("income leaf on a positive row / a card source ⇒ 400; on a bank credit ⇒ income", async () => {
    expect((await adjust({ edits: [{ id: "t1", category: incomeLeaf }] })).status).toBe(400);
    txn("t2").amountAgorot = -100; // negative, but a card source
    expect((await adjust({ edits: [{ id: "t2", category: incomeLeaf }] })).status).toBe(400);
    expect((await adjust({ edits: [{ id: "credit", category: incomeLeaf }] })).status).toBe(200);
    expect(txn("credit")).toMatchObject({ category: incomeLeaf, kind: "income", uncategorized: false });
  });

  it("an expense leaf on a credit row ⇒ a refund (kind expense)", async () => {
    expect((await adjust({ edits: [{ id: "credit", category: expenseLeaf }] })).status).toBe(200);
    expect(txn("credit")).toMatchObject({ category: expenseLeaf, kind: "expense" });
  });

  it("a failed rebuild still applies the edit and says so", async () => {
    builder.mockRejectedValue(new Error("python3: not found"));
    const res = await adjust({ edits: [{ id: "t1", date: "2026-06-01" }] });
    expect(res.status).toBe(200);
    expect((await res.json()).workbook).toBe("failed");
    expect(txn("t1").date).toBe("2026-06-01");
    expect(job()).toMatchObject({ rowsRevision: 1, artifactRevision: 0 });
    expect(String(state.artifacts[0].bytes)).toBe("PK-original");
  });
});

describe("workbook rebuild", () => {
  it("test_rebuilt_workbook_matches_db_rows — the builder gets exactly the job's current rows and the merged taxonomy", async () => {
    job().rowsRevision = 1;
    expect(await rebuildReportWorkbook("jobA", G1)).toBe("updated");
    const input = builder.mock.calls[0][0];
    const expected = state.txns
      .filter((t) => t.jobId === "jobA")
      .map((t) => toWorkbookTxn(t as never));
    expect(input.txns).toHaveLength(expected.length);
    expect(input.txns).toEqual(expect.arrayContaining(expected));
    expect(input.taxonomy.map((s: Row) => s.section)).toEqual(REPORT_TAXONOMY.map((s) => s.section));
    expect(toWorkbookTxn(txn("credit") as never)).toEqual({
      month: "2026-05", date: "2026-05-15", merchant: "עסק credit", amountAgorot: -50000, category: null,
      uncategorized: true, sourceLabel: "hapoalim-1812", note: "", kind: "credit",
    });
  });

  it("test_reversed_rebuild_completion_keeps_the_newer_workbook", async () => {
    const resolvers: ((b: Buffer) => void)[] = [];
    builder.mockImplementation(() => new Promise<Buffer>((r) => resolvers.push(r)));
    const a = adjust({ edits: [{ id: "t1", date: "2026-06-01" }] });
    await vi.waitFor(() => expect(resolvers).toHaveLength(1)); // A's rebuild is in flight at revision 1
    const b = adjust({ edits: [{ id: "t2", date: "2026-06-03" }] });
    await vi.waitFor(() => expect(resolvers).toHaveLength(2)); // B's at revision 2
    resolvers[1](Buffer.from("PK-B")); // B finishes first
    await b;
    resolvers[0](Buffer.from("PK-A")); // A, the older snapshot, finishes last
    await a;
    expect(String(state.artifacts[0].bytes)).toBe("PK-B");
    expect(job()).toMatchObject({ rowsRevision: 2, artifactRevision: 2 });
    expect(state.artifacts).toHaveLength(1);
  });

  it("a snapshot whose revision moves mid-read is retried", async () => {
    job().rowsRevision = 1;
    state.onTxnFindMany = () => {
      job().rowsRevision = 2; // an adjust committed while the rows were read
    };
    expect(await rebuildReportWorkbook("jobA", G1)).toBe("updated");
    expect(job().artifactRevision).toBe(2);
  });

  it("a re-run (generation moved) ⇒ superseded, nothing written", async () => {
    job().rowsRevision = 1;
    job().dispatchedAt = G2;
    expect(await rebuildReportWorkbook("jobA", G1)).toBe("superseded");
    expect(String(state.artifacts[0].bytes)).toBe("PK-original");
    expect(job().artifactRevision).toBe(0);
  });

  it("builder failure / timeout ⇒ failed, nothing written", async () => {
    job().rowsRevision = 1;
    builder.mockRejectedValue(new Error("timed out"));
    expect(await rebuildReportWorkbook("jobA", G1)).toBe("failed");
    expect(job().artifactRevision).toBe(0);
  });
});

describe("ensureFreshWorkbook (publish / download recovery)", () => {
  it("a never-adjusted job is fresh with no rebuild", async () => {
    expect(await ensureFreshWorkbook("jobA")).toBe(true);
    expect(builder).not.toHaveBeenCalled();
  });
  it("a stale artifact is rebuilt when the builder works", async () => {
    job().rowsRevision = 3;
    expect(await ensureFreshWorkbook("jobA")).toBe(true);
    expect(job().artifactRevision).toBe(3);
  });
  it("a stale artifact with a broken builder stays stale and reports it", async () => {
    job().rowsRevision = 3;
    builder.mockRejectedValue(new Error("python3: not found"));
    expect(await ensureFreshWorkbook("jobA")).toBe(false);
    expect(String(state.artifacts[0].bytes)).toBe("PK-original");
  });
});

describe("the real builder", () => {
  let python = true;
  try {
    execFileSync("python3", ["-c", "import openpyxl"], { stdio: "ignore" });
  } catch {
    python = false;
    console.log("[adjustFlow.test] python3 + openpyxl not available — real-builder test skipped");
  }
  it.skipIf(!python)("writes a workbook whose ledger rows equal the input rows", async () => {
    const actual = await vi.importActual<typeof import("@/lib/workbookBuilder")>("@/lib/workbookBuilder");
    const txns = state.txns.filter((t) => t.jobId === "jobA").map((t) => toWorkbookTxn(t as never));
    const bytes = await actual.runWorkbookBuilder({ taxonomy: REPORT_TAXONOMY, txns });
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
    const tmp = path.join(process.env.TMPDIR ?? "/tmp", `plusim-wb-test-${process.pid}.xlsx`);
    const fs = await import("node:fs/promises");
    await fs.writeFile(tmp, bytes);
    try {
      const out = execFileSync("python3", [
        "-c",
        "import json,sys,openpyxl\nws=openpyxl.load_workbook(sys.argv[1])['פירוט תנועות']\n" +
          "print(json.dumps([[c for c in r[1:5]] for r in ws.iter_rows(min_row=4, values_only=True)]))",
        tmp,
      ]).toString();
      const ledger = JSON.parse(out) as [string, string, number, string][];
      const expected = txns.map((t) => [t.date, t.merchant, (t.amountAgorot as number) / 100]);
      expect(ledger.map((r) => [r[0], r[1], r[2]]).sort()).toEqual(expected.sort());
    } finally {
      await fs.rm(tmp, { force: true });
    }
  });
});
