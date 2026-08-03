/**
 * Deleting an entire report job. Cascade (files/transactions/artifacts) is a
 * DB schema concern (onDelete: Cascade) — these tests cover only the route's
 * own logic: the in-progress guard, Drive trash best-effort, and the delete call.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/reportsAdminAuth", () => ({ authorizeReportsRequest: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    reportJob: { findUnique: vi.fn(), delete: vi.fn() },
    merchantMapping: { findMany: vi.fn() },
  },
}));
vi.mock("@/lib/googleDrive", async () => ({
  trashFile: vi.fn(),
  // Not stubbed — the real parser is the thing under test on the sheet path.
  sheetIdFromUrl: (await vi.importActual<typeof import("@/lib/googleDrive")>("@/lib/googleDrive"))
    .sheetIdFromUrl,
}));
vi.mock("@/lib/reportCategories", () => ({ getMergedTaxonomy: vi.fn().mockResolvedValue([]) }));

import { db } from "@/lib/db";
import { authorizeReportsRequest } from "@/lib/reportsAdminAuth";
import * as drive from "@/lib/googleDrive";
import { DELETE as deleteJob } from "./[jobId]/route";

const auth = authorizeReportsRequest as unknown as ReturnType<typeof vi.fn>;
const jobFind = db.reportJob.findUnique as unknown as ReturnType<typeof vi.fn>;
const jobDelete = db.reportJob.delete as unknown as ReturnType<typeof vi.fn>;
const trash = drive.trashFile as unknown as ReturnType<typeof vi.fn>;

const req = () => new NextRequest("http://localhost/admin/api/reports/jobA", { method: "DELETE" });
const params = Promise.resolve({ jobId: "jobA" });

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ actor: "admin@plusim.xyz" });
  jobFind.mockResolvedValue({ id: "jobA", status: "completed", files: [{ driveFileId: "drive-1" }] });
  jobDelete.mockResolvedValue({});
  trash.mockResolvedValue(undefined);
});

describe("DELETE a report job", () => {
  it("refuses while the agent is still working on it", async () => {
    for (const status of ["dispatched", "processing"]) {
      jobFind.mockResolvedValue({ id: "jobA", status, files: [] });
      const res = await deleteJob(req(), { params });
      expect(res.status).toBe(409);
      expect(jobDelete).not.toHaveBeenCalled();
    }
  });

  it("404s for a missing job", async () => {
    jobFind.mockResolvedValue(null);
    const res = await deleteJob(req(), { params });
    expect(res.status).toBe(404);
  });

  it("deletes the job and trashes its Drive files", async () => {
    const res = await deleteJob(req(), { params });
    expect(res.status).toBe(200);
    expect(jobDelete).toHaveBeenCalledWith({ where: { id: "jobA" } });
    expect(trash).toHaveBeenCalledWith("drive-1");
  });

  // The exported sheet is the ONE Drive object that outlives the DB row —
  // artifacts are bytes in Postgres and cascade. Leaving it behind put a stale
  // report next to the new one in the client's folder.
  it("also trashes the exported sheet, so no old report is left in the folder", async () => {
    jobFind.mockResolvedValue({
      id: "jobA",
      status: "published",
      sheetUrl: "https://docs.google.com/spreadsheets/d/SHEET_abc-123/edit",
      files: [{ driveFileId: "drive-1" }],
    });
    const res = await deleteJob(req(), { params });
    expect(res.status).toBe(200);
    expect(trash).toHaveBeenCalledWith("drive-1");
    expect(trash).toHaveBeenCalledWith("SHEET_abc-123");
    expect(trash).toHaveBeenCalledTimes(2);
  });

  it("a never-published job has no sheet to trash", async () => {
    jobFind.mockResolvedValue({
      id: "jobA",
      status: "completed",
      sheetUrl: null,
      files: [{ driveFileId: "drive-1" }],
    });
    await deleteJob(req(), { params });
    expect(trash).toHaveBeenCalledExactlyOnceWith("drive-1");
  });

  // Fail closed on a shape we cannot parse: trash the statements, skip the
  // sheet, still delete the job — never pass `null` to the Drive API.
  it("skips an unparseable sheetUrl instead of trashing something random", async () => {
    jobFind.mockResolvedValue({
      id: "jobA",
      status: "published",
      sheetUrl: "https://example.com/not-a-sheet",
      files: [{ driveFileId: "drive-1" }],
    });
    const res = await deleteJob(req(), { params });
    expect(res.status).toBe(200);
    expect(trash).toHaveBeenCalledExactlyOnceWith("drive-1");
  });

  it("a failing sheet trash still deletes the job", async () => {
    jobFind.mockResolvedValue({
      id: "jobA",
      status: "published",
      sheetUrl: "https://docs.google.com/spreadsheets/d/SHEET_abc-123/edit",
      files: [],
    });
    trash.mockRejectedValue(new Error("drive trash 500"));
    const res = await deleteJob(req(), { params });
    expect(res.status).toBe(200);
    expect(jobDelete).toHaveBeenCalledOnce();
  });

  it("survives a Drive trash failure", async () => {
    trash.mockRejectedValue(new Error("drive trash 500"));
    const res = await deleteJob(req(), { params });
    expect(res.status).toBe(200);
    expect(jobDelete).toHaveBeenCalledOnce();
  });

  it("refuses an unauthorized caller before touching anything", async () => {
    const { NextResponse } = await import("next/server");
    auth.mockResolvedValue(NextResponse.json({ error: "אין הרשאה לפעולה הזו" }, { status: 403 }));
    const res = await deleteJob(req(), { params });
    expect(res.status).toBe(403);
    expect(jobFind).not.toHaveBeenCalled();
  });
});
