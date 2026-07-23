/**
 * Appending statements to an existing job (the "update a ready report" entry
 * point). Named cases banked by the plan review of PR #23:
 *   append_while_running_409, append_keeps_published_visible,
 *   append_containment_matrix, append_rollback_preserves_job,
 *   append_folder_mismatch_409.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/reportsAdminAuth", () => ({ authorizeReportsRequest: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    reportJob: { findUnique: vi.fn(), update: vi.fn(), delete: vi.fn() },
    statementFile: { create: vi.fn(), count: vi.fn(), deleteMany: vi.fn() },
    userDriveFolder: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/googleDrive", () => {
  class DriveNotConnectedError extends Error {}
  class DriveOutsideRootError extends Error {}
  return {
    DriveNotConnectedError,
    DriveOutsideRootError,
    isDriveConnected: vi.fn(),
    assertEntryUnderRoot: vi.fn(),
    uploadBinaryFile: vi.fn(),
    trashFile: vi.fn(),
  };
});

import { db } from "@/lib/db";
import { authorizeReportsRequest } from "@/lib/reportsAdminAuth";
import * as drive from "@/lib/googleDrive";
import { POST as appendPOST } from "./[jobId]/files/route";

const auth = authorizeReportsRequest as unknown as ReturnType<typeof vi.fn>;
const jobFind = db.reportJob.findUnique as unknown as ReturnType<typeof vi.fn>;
const jobUpdate = db.reportJob.update as unknown as ReturnType<typeof vi.fn>;
const jobDelete = db.reportJob.delete as unknown as ReturnType<typeof vi.fn>;
const fileCreate = db.statementFile.create as unknown as ReturnType<typeof vi.fn>;
const fileCount = db.statementFile.count as unknown as ReturnType<typeof vi.fn>;
const fileDeleteMany = db.statementFile.deleteMany as unknown as ReturnType<typeof vi.fn>;
const folderFind = db.userDriveFolder.findUnique as unknown as ReturnType<typeof vi.fn>;
const driveConnected = drive.isDriveConnected as unknown as ReturnType<typeof vi.fn>;
const assertRoot = drive.assertEntryUnderRoot as unknown as ReturnType<typeof vi.fn>;
const uploadBin = drive.uploadBinaryFile as unknown as ReturnType<typeof vi.fn>;
const trash = drive.trashFile as unknown as ReturnType<typeof vi.fn>;

const params = { params: Promise.resolve({ jobId: "jobA" }) };

function appendReq(names = ["extra.pdf"]) {
  const fd = new FormData();
  for (const n of names) {
    fd.append("files", new File([Buffer.from("%PDF-1.4 statement")], n, { type: "application/pdf" }));
  }
  return new NextRequest("https://plusim.xyz/admin/api/reports/jobA/files", { method: "POST", body: fd });
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ actor: "admin@plusim.xyz" });
  jobFind.mockResolvedValue({ id: "jobA", status: "published", targetUserId: "u1" });
  driveConnected.mockResolvedValue(true);
  folderFind.mockResolvedValue({ userId: "u1", folderId: "folder-1" });
  assertRoot.mockResolvedValue({ id: "folder-1" });
  fileCount.mockResolvedValue(0);
  uploadBin.mockResolvedValue({ id: "drive-new" });
  fileCreate.mockResolvedValue({ id: "row-new" });
  fileDeleteMany.mockResolvedValue({ count: 0 });
  trash.mockResolvedValue(undefined);
});

describe("append_while_running_409", () => {
  for (const status of ["dispatched", "processing"]) {
    it(`${status} → 409, nothing uploaded`, async () => {
      jobFind.mockResolvedValue({ id: "jobA", status, targetUserId: "u1" });
      const res = await appendPOST(appendReq(), params);
      expect(res.status).toBe(409);
      expect(uploadBin).not.toHaveBeenCalled();
      expect(fileCreate).not.toHaveBeenCalled();
    });
  }
});

it("append_keeps_published_visible — appending never changes job state", async () => {
  const res = await appendPOST(appendReq(["a.pdf", "b.pdf"]), params);
  expect(res.status).toBe(200);
  await expect(res.json()).resolves.toMatchObject({ ok: true, added: 2 });
  expect(fileCreate).toHaveBeenCalledTimes(2);
  // The client keeps seeing the published report until the admin re-runs.
  expect(jobUpdate).not.toHaveBeenCalled();
});

describe("append_containment_matrix", () => {
  it("Drive not connected → 409, nothing written", async () => {
    driveConnected.mockResolvedValue(false);
    const res = await appendPOST(appendReq(), params);
    expect(res.status).toBe(409);
    expect(uploadBin).not.toHaveBeenCalled();
  });

  it("user has no assigned folder → 409, nothing written", async () => {
    folderFind.mockResolvedValue(null);
    const res = await appendPOST(appendReq(), params);
    expect(res.status).toBe(409);
    expect(uploadBin).not.toHaveBeenCalled();
  });

  it("assigned folder moved outside the root → 409, nothing written", async () => {
    assertRoot.mockRejectedValue(new drive.DriveOutsideRootError("outside root"));
    const res = await appendPOST(appendReq(), params);
    expect(res.status).toBe(409);
    expect(uploadBin).not.toHaveBeenCalled();
  });

  it("unknown job → 404", async () => {
    jobFind.mockResolvedValue(null);
    const res = await appendPOST(appendReq(), params);
    expect(res.status).toBe(404);
  });

  it("a non-statement file type → 400, nothing written", async () => {
    const fd = new FormData();
    fd.append("files", new File([Buffer.from("MZ not a statement")], "x.exe", { type: "application/octet-stream" }));
    const req = new NextRequest("https://plusim.xyz/admin/api/reports/jobA/files", { method: "POST", body: fd });
    const res = await appendPOST(req, params);
    expect(res.status).toBe(400);
    expect(uploadBin).not.toHaveBeenCalled();
  });
});

it("append_folder_mismatch_409 — existing rows in a previously assigned folder", async () => {
  fileCount.mockResolvedValue(2); // rows whose driveFolderId != the current folder
  const res = await appendPOST(appendReq(), params);
  expect(res.status).toBe(409);
  expect(uploadBin).not.toHaveBeenCalled();
  expect(fileCreate).not.toHaveBeenCalled();
});

it("append_rollback_preserves_job — mid-loop failure removes ONLY what it added", async () => {
  uploadBin
    .mockResolvedValueOnce({ id: "drive-1" })
    .mockRejectedValueOnce(new Error("drive 500"));
  fileCreate.mockResolvedValueOnce({ id: "row-1" });

  const res = await appendPOST(appendReq(["a.pdf", "b.pdf"]), params);
  expect(res.status).toBe(502);
  // The one file that landed is trashed and its row deleted…
  expect(trash).toHaveBeenCalledWith("drive-1");
  expect(fileDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["row-1"] } } });
  // …and the job itself (with its earlier files and report) survives.
  expect(jobDelete).not.toHaveBeenCalled();
  expect(jobUpdate).not.toHaveBeenCalled();
});
