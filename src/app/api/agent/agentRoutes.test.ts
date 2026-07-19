/**
 * Route-level auth + Drive read-confinement for the public /api/agent routes.
 * Proves each handler actually invokes authorizeAgentJobRequest (a route that
 * forgot it would leak to anyone holding the shared bearer) and that files/
 * binds the read to the job user's folder.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  db: {
    reportJob: { findUnique: vi.fn() },
    statementFile: { findMany: vi.fn(), findFirst: vi.fn() },
    merchantMapping: { findMany: vi.fn() },
    userDriveFolder: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/googleDrive", () => {
  class DriveOutsideRootError extends Error {}
  return {
    DriveOutsideRootError,
    assertEntryUnderFolder: vi.fn(),
    getFileBytes: vi.fn(),
  };
});

import { db } from "@/lib/db";
import * as drive from "@/lib/googleDrive";
import { sha256Hex } from "@/lib/agentRuntimeAuth";
import { GET as manifestGET } from "./jobs/[jobId]/manifest/route";
import { GET as filesGET } from "./jobs/[jobId]/files/[fileId]/route";
import { POST as resultPOST } from "./jobs/[jobId]/result/route";

const RUNTIME = "runtime-secret";
const TOKEN = "job-token";
const jobFind = db.reportJob.findUnique as unknown as ReturnType<typeof vi.fn>;
const fileFind = db.statementFile.findFirst as unknown as ReturnType<typeof vi.fn>;
const folderFind = db.userDriveFolder.findUnique as unknown as ReturnType<typeof vi.fn>;
const assertUnderFolder = drive.assertEntryUnderFolder as unknown as ReturnType<typeof vi.fn>;
const getBytes = drive.getFileBytes as unknown as ReturnType<typeof vi.fn>;

function validJob(over: Record<string, unknown> = {}) {
  return {
    id: "jobA",
    targetUserId: "user-1",
    status: "processing",
    agentTokenHash: sha256Hex(TOKEN),
    agentTokenExpiresAt: new Date(Date.now() + 60_000),
    ...over,
  };
}

function req(path: string, opts: { bearer?: string; t?: string } = {}) {
  const url = `https://plusim.xyz/api/agent/${path}${opts.t !== undefined ? `?t=${opts.t}` : ""}`;
  const headers: Record<string, string> = {};
  if (opts.bearer !== undefined) headers.authorization = `Bearer ${opts.bearer}`;
  return new NextRequest(url, { headers });
}
const params = <T extends Record<string, string>>(o: T) => ({ params: Promise.resolve(o) });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.PLUSIM_AGENT_RUNTIME_TOKEN = RUNTIME;
});

describe("each public agent route invokes the guard", () => {
  it("manifest: missing bearer → 401", async () => {
    const res = await manifestGET(req("jobs/jobA/manifest", { t: TOKEN }), params({ jobId: "jobA" }));
    expect(res.status).toBe(401);
  });
  it("manifest: valid bearer + WRONG per-job token → 404", async () => {
    jobFind.mockResolvedValue(validJob());
    const res = await manifestGET(req("jobs/jobA/manifest", { bearer: RUNTIME, t: "wrong" }), params({ jobId: "jobA" }));
    expect(res.status).toBe(404);
  });
  it("files: missing bearer → 401", async () => {
    const res = await filesGET(req("jobs/jobA/files/f1", { t: TOKEN }), params({ jobId: "jobA", fileId: "f1" }));
    expect(res.status).toBe(401);
  });
  it("result: valid bearer + WRONG per-job token → 404", async () => {
    jobFind.mockResolvedValue(validJob());
    const res = await resultPOST(req("jobs/jobA/result", { bearer: RUNTIME, t: "wrong" }), params({ jobId: "jobA" }));
    expect(res.status).toBe(404);
  });
});

describe("files/[fileId] — Drive read bound to the job user's folder", () => {
  beforeEach(() => jobFind.mockResolvedValue(validJob()));

  it("fileId not belonging to the job → 404", async () => {
    fileFind.mockResolvedValue(null);
    const res = await filesGET(req("jobs/jobA/files/f1", { bearer: RUNTIME, t: TOKEN }), params({ jobId: "jobA", fileId: "f1" }));
    expect(res.status).toBe(404);
  });

  it("driveFolderId no longer matches the user's current folder → 404", async () => {
    fileFind.mockResolvedValue({ id: "f1", jobId: "jobA", mime: "application/pdf", filename: "s.pdf", driveFileId: "d1", driveFolderId: "OLD" });
    folderFind.mockResolvedValue({ userId: "user-1", folderId: "CURRENT" });
    const res = await filesGET(req("jobs/jobA/files/f1", { bearer: RUNTIME, t: TOKEN }), params({ jobId: "jobA", fileId: "f1" }));
    expect(res.status).toBe(404);
    expect(assertUnderFolder).not.toHaveBeenCalled();
  });

  it("file in another user's folder under the same root (assert fails) → 403", async () => {
    fileFind.mockResolvedValue({ id: "f1", jobId: "jobA", mime: "application/pdf", filename: "s.pdf", driveFileId: "d1", driveFolderId: "FOLDER" });
    folderFind.mockResolvedValue({ userId: "user-1", folderId: "FOLDER" });
    assertUnderFolder.mockRejectedValue(new drive.DriveOutsideRootError("outside"));
    const res = await filesGET(req("jobs/jobA/files/f1", { bearer: RUNTIME, t: TOKEN }), params({ jobId: "jobA", fileId: "f1" }));
    expect(res.status).toBe(403);
  });

  it("happy path streams the bytes", async () => {
    fileFind.mockResolvedValue({ id: "f1", jobId: "jobA", mime: "application/pdf", filename: "s.pdf", driveFileId: "d1", driveFolderId: "FOLDER" });
    folderFind.mockResolvedValue({ userId: "user-1", folderId: "FOLDER" });
    assertUnderFolder.mockResolvedValue({ id: "d1", mimeType: "application/pdf", isFolder: false });
    getBytes.mockResolvedValue(Buffer.from("PDF-BYTES"));
    const res = await filesGET(req("jobs/jobA/files/f1", { bearer: RUNTIME, t: TOKEN }), params({ jobId: "jobA", fileId: "f1" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("PDF-BYTES");
  });
});
