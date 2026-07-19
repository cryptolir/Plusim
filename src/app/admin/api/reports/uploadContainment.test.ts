/**
 * Upload write-confinement (ask 2): statements only ever land in the target
 * user's assigned Drive folder. No folder / Drive not connected / a folder moved
 * outside the root or deleted after assignment ⇒ refuse (409), nothing written.
 */
import { it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/reportsAdminAuth", () => ({ authorizeReportsRequest: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    userDriveFolder: { findUnique: vi.fn() },
    reportJob: { create: vi.fn(), delete: vi.fn() },
    statementFile: { create: vi.fn() },
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
import { POST as uploadPOST } from "./route";

const auth = authorizeReportsRequest as unknown as ReturnType<typeof vi.fn>;
const folderFind = db.userDriveFolder.findUnique as unknown as ReturnType<typeof vi.fn>;
const jobCreate = db.reportJob.create as unknown as ReturnType<typeof vi.fn>;
const driveConnected = drive.isDriveConnected as unknown as ReturnType<typeof vi.fn>;
const assertRoot = drive.assertEntryUnderRoot as unknown as ReturnType<typeof vi.fn>;
const uploadBin = drive.uploadBinaryFile as unknown as ReturnType<typeof vi.fn>;

function uploadReq() {
  const fd = new FormData();
  fd.set("targetUserId", "user-1");
  fd.append("files", new File([Buffer.from("%PDF-1.4 statement")], "s.pdf", { type: "application/pdf" }));
  return new NextRequest("https://plusim.xyz/admin/api/reports", { method: "POST", body: fd });
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ actor: "admin@plusim.xyz" });
});

it("Drive not connected → 409, nothing written", async () => {
  driveConnected.mockResolvedValue(false);
  const res = await uploadPOST(uploadReq());
  expect(res.status).toBe(409);
  expect(jobCreate).not.toHaveBeenCalled();
  expect(uploadBin).not.toHaveBeenCalled();
});

it("target user has no assigned folder → 409, nothing written", async () => {
  driveConnected.mockResolvedValue(true);
  folderFind.mockResolvedValue(null);
  const res = await uploadPOST(uploadReq());
  expect(res.status).toBe(409);
  expect(jobCreate).not.toHaveBeenCalled();
});

it("assigned folder moved outside root / deleted after assignment → 409, nothing written", async () => {
  driveConnected.mockResolvedValue(true);
  folderFind.mockResolvedValue({ userId: "user-1", folderId: "moved-folder" });
  assertRoot.mockRejectedValue(new drive.DriveOutsideRootError("outside root"));
  const res = await uploadPOST(uploadReq());
  expect(res.status).toBe(409);
  expect(jobCreate).not.toHaveBeenCalled();
  expect(uploadBin).not.toHaveBeenCalled();
});
