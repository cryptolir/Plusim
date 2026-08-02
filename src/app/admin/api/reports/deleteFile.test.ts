/**
 * Removing one statement file from a job. The invariants that matter:
 *   delete_while_running_409   — a file-list change mid-run desyncs the manifest
 *   delete_cross_job_404       — a fileId from another job must not delete
 *   delete_keeps_report        — the stored report/transactions are untouched;
 *                                only the next run rebuilds from what is left
 *   delete_survives_drive_fail — the row is the source of truth for the next run
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/reportsAdminAuth", () => ({ authorizeReportsRequest: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    reportJob: { findUnique: vi.fn() },
    statementFile: { findUnique: vi.fn(), delete: vi.fn() },
    reportTransaction: { deleteMany: vi.fn() },
    reportArtifact: { deleteMany: vi.fn() },
  },
}));
vi.mock("@/lib/googleDrive", () => ({ trashFile: vi.fn() }));

import { db } from "@/lib/db";
import { authorizeReportsRequest } from "@/lib/reportsAdminAuth";
import * as drive from "@/lib/googleDrive";
import { DELETE as deleteFile } from "./[jobId]/files/[fileId]/route";

const auth = authorizeReportsRequest as unknown as ReturnType<typeof vi.fn>;
const jobFind = db.reportJob.findUnique as unknown as ReturnType<typeof vi.fn>;
const fileFind = db.statementFile.findUnique as unknown as ReturnType<typeof vi.fn>;
const fileDelete = db.statementFile.delete as unknown as ReturnType<typeof vi.fn>;
const txDeleteMany = db.reportTransaction.deleteMany as unknown as ReturnType<typeof vi.fn>;
const artifactDeleteMany = db.reportArtifact.deleteMany as unknown as ReturnType<typeof vi.fn>;
const trash = drive.trashFile as unknown as ReturnType<typeof vi.fn>;

const req = () => new NextRequest("http://localhost/admin/api/reports/jobA/files/fileA", { method: "DELETE" });
const params = Promise.resolve({ jobId: "jobA", fileId: "fileA" });
const FILE = { id: "fileA", jobId: "jobA", filename: "דיסקונט.xlsx", driveFileId: "drive-1" };

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ actor: "admin@plusim.xyz" });
  jobFind.mockResolvedValue({ id: "jobA", status: "completed" });
  fileFind.mockResolvedValue(FILE);
  fileDelete.mockResolvedValue(FILE);
  trash.mockResolvedValue(undefined);
});

describe("DELETE a statement file", () => {
  it("delete_while_running_409 — refuses while the agent holds the manifest", async () => {
    for (const status of ["dispatched", "processing"]) {
      jobFind.mockResolvedValue({ id: "jobA", status });
      const res = await deleteFile(req(), { params });
      expect(res.status).toBe(409);
      expect(fileDelete).not.toHaveBeenCalled();
      expect(trash).not.toHaveBeenCalled();
    }
  });

  it("delete_cross_job_404 — a file belonging to another job is never deleted", async () => {
    fileFind.mockResolvedValue({ ...FILE, jobId: "jobB" });
    const res = await deleteFile(req(), { params });
    expect(res.status).toBe(404);
    expect(fileDelete).not.toHaveBeenCalled();
  });

  it("deletes the row and trashes the Drive file", async () => {
    const res = await deleteFile(req(), { params });
    expect(res.status).toBe(200);
    expect(fileDelete).toHaveBeenCalledWith({ where: { id: "fileA" } });
    expect(trash).toHaveBeenCalledWith("drive-1");
  });

  it("delete_keeps_report — the stored report survives; only a re-run rebuilds it", async () => {
    const res = await deleteFile(req(), { params });
    expect(res.status).toBe(200);
    expect(txDeleteMany).not.toHaveBeenCalled();
    expect(artifactDeleteMany).not.toHaveBeenCalled();
  });

  it("delete_survives_drive_fail — a Drive hiccup does not resurrect the row", async () => {
    trash.mockRejectedValue(new Error("drive trash 500"));
    const res = await deleteFile(req(), { params });
    expect(res.status).toBe(200);
    expect(fileDelete).toHaveBeenCalledOnce();
  });

  it("refuses an unauthorized caller before touching anything", async () => {
    const { NextResponse } = await import("next/server");
    auth.mockResolvedValue(NextResponse.json({ error: "אין הרשאה לפעולה הזו" }, { status: 403 }));
    const res = await deleteFile(req(), { params });
    expect(res.status).toBe(403);
    expect(fileFind).not.toHaveBeenCalled();
    expect(fileDelete).not.toHaveBeenCalled();
  });
});
