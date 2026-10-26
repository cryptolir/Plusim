/**
 * Byte-identical statement refusal (docs/plans/scale-large-statements.md B2).
 * The same bytes twice in one request, or again on the SAME job, are refused with
 * a Hebrew 409 BEFORE any Drive write; the same bytes on ANOTHER job are allowed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";

vi.mock("@/lib/reportsAdminAuth", () => ({ authorizeReportsRequest: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    reportJob: { findUnique: vi.fn(), create: vi.fn(), delete: vi.fn() },
    statementFile: { create: vi.fn(), count: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn() },
    userDriveFolder: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/googleDrive", () => {
  class DriveNotConnectedError extends Error {}
  return {
    DriveNotConnectedError,
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
import { POST as createPOST } from "./route";

const auth = authorizeReportsRequest as unknown as ReturnType<typeof vi.fn>;
const jobFind = db.reportJob.findUnique as unknown as ReturnType<typeof vi.fn>;
const jobCreate = db.reportJob.create as unknown as ReturnType<typeof vi.fn>;
const fileCreate = db.statementFile.create as unknown as ReturnType<typeof vi.fn>;
const fileCount = db.statementFile.count as unknown as ReturnType<typeof vi.fn>;
const fileFindMany = db.statementFile.findMany as unknown as ReturnType<typeof vi.fn>;
const folderFind = db.userDriveFolder.findUnique as unknown as ReturnType<typeof vi.fn>;
const uploadBin = drive.uploadBinaryFile as unknown as ReturnType<typeof vi.fn>;
const connected = drive.isDriveConnected as unknown as ReturnType<typeof vi.fn>;
const assertRoot = drive.assertEntryUnderRoot as unknown as ReturnType<typeof vi.fn>;

const A = Buffer.from("%PDF-1.4 statement A");
const B = Buffer.from("%PDF-1.4 statement B");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const params = { params: Promise.resolve({ jobId: "jobA" }) };

function form(files: { name: string; bytes: Buffer }[], extra: Record<string, string> = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  for (const f of files) fd.append("files", new File([f.bytes], f.name, { type: "application/pdf" }));
  return fd;
}
const appendReq = (files: { name: string; bytes: Buffer }[]) =>
  new NextRequest("https://plusim.xyz/admin/api/reports/jobA/files", { method: "POST", body: form(files) });
const createReq = (files: { name: string; bytes: Buffer }[]) =>
  new NextRequest("https://plusim.xyz/admin/api/reports", { method: "POST", body: form(files, { targetUserId: "u1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  auth.mockResolvedValue({ actor: "admin@plusim.xyz" });
  jobFind.mockResolvedValue({ id: "jobA", status: "completed", targetUserId: "u1" });
  jobCreate.mockResolvedValue({ id: "newJob" });
  connected.mockResolvedValue(true);
  folderFind.mockResolvedValue({ userId: "u1", folderId: "folder-1" });
  assertRoot.mockResolvedValue({ id: "folder-1" });
  fileCount.mockResolvedValue(0);
  fileFindMany.mockResolvedValue([]);
  uploadBin.mockResolvedValue({ id: "drive-x" });
  fileCreate.mockResolvedValue({ id: "row-x" });
});

describe("identical statement refusal", () => {
  it("the same bytes twice in one append request → 409 (Hebrew), nothing uploaded", async () => {
    const res = await appendPOST(appendReq([{ name: "a.pdf", bytes: A }, { name: "copy.pdf", bytes: A }]), params);
    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error).toMatch(/[֐-׿]/);
    expect(error).toContain("copy.pdf");
    expect(error).toContain("a.pdf");
    expect(uploadBin).not.toHaveBeenCalled();
    expect(fileCreate).not.toHaveBeenCalled();
  });

  it("the same bytes twice in one CREATE request → 409, no job created", async () => {
    const res = await createPOST(createReq([{ name: "a.pdf", bytes: A }, { name: "b.pdf", bytes: A }]));
    expect(res.status).toBe(409);
    expect(jobCreate).not.toHaveBeenCalled();
    expect(uploadBin).not.toHaveBeenCalled();
  });

  it("bytes already on THIS job → 409 before any Drive write, naming both files", async () => {
    fileFindMany.mockResolvedValue([{ sha256: sha(A), filename: "january.pdf" }]);
    const res = await appendPOST(appendReq([{ name: "again.pdf", bytes: A }]), params);
    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error).toContain("again.pdf");
    expect(error).toContain("january.pdf");
    expect(fileFindMany.mock.calls[0][0].where).toEqual({ jobId: "jobA", sha256: { in: [sha(A)] } });
    expect(uploadBin).not.toHaveBeenCalled();
  });

  it("the same bytes on ANOTHER job are allowed (the lookup is scoped to this job)", async () => {
    // the db answers only for jobA's rows; nothing on jobA matches
    fileFindMany.mockResolvedValue([]);
    const res = await appendPOST(appendReq([{ name: "a.pdf", bytes: A }]), params);
    expect(res.status).toBe(200);
    expect(fileFindMany.mock.calls[0][0].where.jobId).toBe("jobA");
  });

  it("distinct files pass, and each row is stored with its sha256", async () => {
    const res = await appendPOST(appendReq([{ name: "a.pdf", bytes: A }, { name: "b.pdf", bytes: B }]), params);
    expect(res.status).toBe(200);
    expect(fileCreate).toHaveBeenCalledTimes(2);
    expect(fileCreate.mock.calls.map((c) => c[0].data.sha256)).toEqual([sha(A), sha(B)]);
  });

  it("create also stores the sha256 on every row", async () => {
    const res = await createPOST(createReq([{ name: "a.pdf", bytes: A }]));
    expect(res.status).toBe(200);
    expect(fileCreate.mock.calls[0][0].data.sha256).toBe(sha(A));
  });
});
