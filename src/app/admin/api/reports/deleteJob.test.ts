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
vi.mock("@/lib/googleDrive", () => ({ trashFile: vi.fn() }));
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
