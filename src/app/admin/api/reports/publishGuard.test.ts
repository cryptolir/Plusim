/**
 * Publish guard: a job carrying FATAL verification diagnostics must never
 * publish (409, no Sheet export, status unchanged); a non-fatal job (clean, or
 * merely uncategorized) publishes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/reportsAdminAuth", () => ({ authorizeReportsRequest: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    reportJob: { findUnique: vi.fn(), update: vi.fn() },
    reportTransaction: { count: vi.fn() },
    reportArtifact: { findFirst: vi.fn() },
    userDriveFolder: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/googleDrive", () => ({
  isDriveConnected: vi.fn(),
  assertEntryUnderRoot: vi.fn(),
  uploadXlsxAsSpreadsheet: vi.fn(),
}));

import { db } from "@/lib/db";
import { authorizeReportsRequest } from "@/lib/reportsAdminAuth";
import { isDriveConnected } from "@/lib/googleDrive";
import { POST as publishPOST } from "./[jobId]/publish/route";

const auth = authorizeReportsRequest as unknown as ReturnType<typeof vi.fn>;
const jobFind = db.reportJob.findUnique as unknown as ReturnType<typeof vi.fn>;
const jobUpdate = db.reportJob.update as unknown as ReturnType<typeof vi.fn>;
const txCount = db.reportTransaction.count as unknown as ReturnType<typeof vi.fn>;
const driveConnected = isDriveConnected as unknown as ReturnType<typeof vi.fn>;

const req = () => new NextRequest("https://plusim.xyz/admin/api/reports/jobA/publish", { method: "POST" });
const params = { params: Promise.resolve({ jobId: "jobA" }) };

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ actor: "admin@plusim.xyz" });
  txCount.mockResolvedValue(0);
  driveConnected.mockResolvedValue(false); // skip Sheet export
});

const FATAL_CLASSES: Record<string, unknown> = {
  "total mismatch": { fatal: true, problems: ['source "x": recomputed 1 ≠ statement 2 agorot'] },
  "duplicate dedupKey": { fatal: true, problems: ["duplicate dedupKey v-1"] },
  "date outside month": { fatal: true, problems: ["txn date 2026-07-01 outside its month 2026-06"] },
  "unknown category": { fatal: true, problems: ['unknown category "zzz"'] },
  "non-xlsx payload": { fatal: true, problems: ["xlsx payload is not a valid zip container"] },
};

describe("publish refuses every fatal class", () => {
  for (const [name, verification] of Object.entries(FATAL_CLASSES)) {
    it(`${name} → 409, nothing published`, async () => {
      jobFind.mockResolvedValue({ id: "jobA", status: "needs_review", targetUserId: "u1", title: "t", sheetUrl: null, verification });
      const res = await publishPOST(req(), params);
      expect(res.status).toBe(409);
      expect(jobUpdate).not.toHaveBeenCalled();
    });
  }
});

describe("publish allows non-fatal jobs", () => {
  it("clean completed job → published", async () => {
    jobFind.mockResolvedValue({ id: "jobA", status: "completed", targetUserId: "u1", title: "t", sheetUrl: null, verification: { fatal: false, problems: [] } });
    const res = await publishPOST(req(), params);
    expect(res.status).toBe(200);
    expect(jobUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "published" }) }));
  });

  it("non-fatal job with only uncategorized rows → published", async () => {
    jobFind.mockResolvedValue({ id: "jobA", status: "needs_review", targetUserId: "u1", title: "t", sheetUrl: null, verification: { fatal: false, problems: [] } });
    txCount.mockResolvedValue(3); // uncategorized rows remain — still publishable
    const res = await publishPOST(req(), params);
    expect(res.status).toBe(200);
    expect(jobUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "published" }) }));
  });
});
