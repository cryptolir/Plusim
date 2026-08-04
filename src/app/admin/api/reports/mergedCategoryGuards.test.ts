/**
 * Admin routes honor the MERGED (base ∪ ReportCategory) leaf set:
 *  - assign route accepts a DB category / still rejects an unknown one
 *  - mapping-approval route accepts a DB category
 *  - job-detail GET serves categoryLeaves (the assign picker's only source)
 *    including DB categories — a base-only static list would fail this.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/reportsAdminAuth", () => ({ authorizeReportsRequest: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    reportCategory: { findMany: vi.fn() },
    // updateMany, not update: the assign write is conditional on the parent
    // job not being mid-run, so `count` is the success signal.
    reportTransaction: { findFirst: vi.fn(), updateMany: vi.fn() },
    merchantMapping: { findUnique: vi.fn(), update: vi.fn(), upsert: vi.fn(), findMany: vi.fn() },
    reportJob: { findUnique: vi.fn() },
  },
}));

import { db } from "@/lib/db";
import { authorizeReportsRequest } from "@/lib/reportsAdminAuth";
import { PATCH as assignPATCH } from "./[jobId]/transactions/[txId]/route";
import { PATCH as mappingPATCH } from "../report-mappings/[id]/route";
import { GET as detailGET } from "./[jobId]/route";

const auth = authorizeReportsRequest as unknown as ReturnType<typeof vi.fn>;
const categories = db.reportCategory.findMany as unknown as ReturnType<typeof vi.fn>;
const txFind = db.reportTransaction.findFirst as unknown as ReturnType<typeof vi.fn>;
const txUpdate = db.reportTransaction.updateMany as unknown as ReturnType<typeof vi.fn>;
const mapFind = db.merchantMapping.findUnique as unknown as ReturnType<typeof vi.fn>;
const mapMany = db.merchantMapping.findMany as unknown as ReturnType<typeof vi.fn>;
const jobFind = db.reportJob.findUnique as unknown as ReturnType<typeof vi.fn>;

const DB_LEAF = "קטגוריה חדשה";

function patchReq(url: string, body: unknown) {
  return new NextRequest(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ actor: "admin@plusim.xyz" });
  categories.mockResolvedValue([{ name: DB_LEAF, section: "שונות" }]);
});

describe("assign route uses the merged set", () => {
  const params = { params: Promise.resolve({ jobId: "jobA", txId: "tx1" }) };

  it("accepts a DB category (test_assign_accepts_db_category)", async () => {
    txFind.mockResolvedValue({ id: "tx1", jobId: "jobA", merchant: "חנות" });
    txUpdate.mockResolvedValue({ count: 1 });
    const res = await assignPATCH(
      patchReq("https://plusim.xyz/admin/api/reports/jobA/transactions/tx1", { category: DB_LEAF }),
      params,
    );
    expect(res.status).toBe(200);
    expect(txUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { category: DB_LEAF, uncategorized: false } }),
    );
  });

  it("still rejects an unknown category with 400 (test_assign_rejects_unknown)", async () => {
    const res = await assignPATCH(
      patchReq("https://plusim.xyz/admin/api/reports/jobA/transactions/tx1", { category: "לא-קיימת" }),
      params,
    );
    expect(res.status).toBe(400);
    expect(txUpdate).not.toHaveBeenCalled();
  });
});

describe("mapping route uses the merged set", () => {
  it("approves a mapping onto a DB category (test_mapping_approve_accepts_db_category)", async () => {
    mapFind.mockResolvedValue({ id: "m1", merchantPattern: "חנות", category: "ביט" });
    const res = await mappingPATCH(
      patchReq("https://plusim.xyz/admin/api/report-mappings/m1", { approved: true, category: DB_LEAF }),
      { params: Promise.resolve({ id: "m1" }) },
    );
    expect(res.status).toBe(200);
    expect(db.merchantMapping.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { approved: true, category: DB_LEAF } }),
    );
  });
});

describe("assign picker source (job-detail GET)", () => {
  it("categoryLeaves includes DB categories after their section's base leaves (test_assign_picker_includes_db_category)", async () => {
    jobFind.mockResolvedValue({ id: "jobA", transactions: [], files: [], artifacts: [] });
    mapMany.mockResolvedValue([]);
    const res = await detailGET(new NextRequest("https://plusim.xyz/admin/api/reports/jobA"), {
      params: Promise.resolve({ jobId: "jobA" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.categoryLeaves).toContain(DB_LEAF);
    expect(body.categoryLeaves).toContain("מזון ומכולת"); // base leaves still present
    // merged order: the DB leaf lands inside its section, not appended globally
    expect(body.categoryLeaves.indexOf(DB_LEAF)).toBeGreaterThan(body.categoryLeaves.indexOf("ביט"));
  });
});
